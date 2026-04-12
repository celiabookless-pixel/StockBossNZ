import { useState, useRef, useEffect } from 'react';
import { getListings, saveAllListings, getMessages, saveMessage, uploadPhoto } from './supabase';

const SYSTEM_PROMPT = `You are StockBossNZ, a smart livestock matching AI for stock agents in New Zealand and Australia. Respond ONLY with raw JSON, no markdown, no backticks, no explanation.

JSON shape:
{
  "action": "add" or "sell" or "query" or "price_estimate" or "chat",
  "message": "plain English reply to show the user",
  "listings": [ full updated listings array - only include when action is add or sell ],
  "results": [ matching listing ids - only include when action is query ],
  "estimate": { "low": number, "mid": number, "high": number, "reasoning": "string" } - only when action is price_estimate
}

Listing shape:
{
  "id": "lst_" plus unix timestamp e.g. lst_1700000001,
  "seller": "name only",
  "sellerPhone": "phone number if mentioned, else null",
  "buyer": "buyer name if sold, else null",
  "buyerPhone": "buyer phone if mentioned, else null",
  "breed": "e.g. Angus, Friesian, Hereford, Murray Grey, Merino",
  "category": "steers or heifers or cows or bulls or calves or ewes or rams or lambs or wethers or other",
  "age": "e.g. R2, R3, Weaner, 18mo",
  "weightKg": number or null,
  "condition": "e.g. Good, Store, Fat, Backgrounder",
  "location": "property or town name",
  "trucking": "trucking notes e.g. owner can truck, needs arranging",
  "nature": "e.g. quiet, flighty, PTIC, joined",
  "quantity": number,
  "quantitySold": number,
  "pricePerHead": number or null,
  "centsPerKg": number or null,
  "notes": "any other info",
  "photoUrl": null,
  "dateAdded": "ISO date string",
  "dateSold": null or "ISO date string",
  "status": "available or partial or sold"
}

Rules:
- add: create new listing with unique id using current timestamp
- sell: update quantitySold, set dateSold, status = partial if some remain, sold if all gone. Return full listings array.
- query: find available/partial listings matching the request. Return ids of best matches.
- price_estimate: look at sold listings to estimate price range. Return estimate with low/mid/high and reasoning.
- Always return the FULL listings array on add or sell.
- Extract as much detail as possible from natural language.
- If weight mentioned calculate centsPerKg if price also given.`;

const CAT_COLORS = {
  steers: '#2d6a4f', heifers: '#40916c', cows: '#52b788',
  bulls: '#1b4332', calves: '#74c69d', ewes: '#6d4c41',
  rams: '#4e342e', lambs: '#a1887f', wethers: '#8d6e63', other: '#78909c'
};

function getBadge(status, qty, sold) {
  if (status === 'sold') return { label: 'SOLD', color: '#c0392b' };
  if (status === 'partial') return { label: (qty - sold) + ' LEFT', color: '#e67e22' };
  return { label: 'AVAILABLE', color: '#27ae60' };
}

async function askClaude(userMsg, listings) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Current date: ' + new Date().toISOString() + '\nDatabase: ' + JSON.stringify(listings) + '\n\nMessage: ' + userMsg
      }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(function() { return {}; });
    throw new Error((e.error && e.error.message) || ('API error ' + res.status));
  }
  const data = await res.json();
  const raw = (data.content || []).map(function(b) { return b.text || ''; }).join('').trim();
  return JSON.parse(raw);
}

export default function App() {
  const [listings, setListings] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('chat');
  const [matches, setMatches] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState('all');
  const [notification, setNotification] = useState(null);
  const bottom = useRef(null);
  const fileRef = useRef(null);

  useEffect(function() {
    async function load() {
      try {
        const [ls, ms] = await Promise.all([getListings(), getMessages()]);
        const mapped = ls.map(function(l) {
          return {
            id: l.id, seller: l.seller, sellerPhone: l.seller_phone,
            buyer: l.buyer, buyerPhone: l.buyer_phone,
            breed: l.breed, category: l.category,
            age: l.age, weightKg: l.weight_kg, condition: l.condition,
            location: l.location, trucking: l.trucking, nature: l.nature,
            quantity: l.quantity, quantitySold: l.quantity_sold,
            pricePerHead: l.price_per_head, centsPerKg: l.cents_per_kg,
            notes: l.notes, photoUrl: l.photo_url,
            dateAdded: l.date_added, dateSold: l.date_sold, status: l.status
          };
        });
        setListings(mapped);
        if (ms.length > 0) {
          setMsgs(ms);
        } else {
          setMsgs([{ from: 'ai', text: "G'day! I'm StockBossNZ — your smart livestock matching assistant. Tell me what stock is for sale, e.g. 'Pete has 80 Angus R2 steers, 420kg, good condition, Hawke's Bay, $1100/hd' — or ask what's available, or ask for a price estimate.", extra: null }]);
        }
      } catch(e) {
        setErr('Could not load data: ' + e.message);
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(function() {
    if (bottom.current) bottom.current.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  function showNotification(text) {
    setNotification(text);
    setTimeout(function() { setNotification(null); }, 4000);
  }

  async function send(overrideInput) {
    const msg = (overrideInput || input).trim();
    if (!msg || busy) return;
    setInput('');
    setErr(null);
    setMatches(null);
    const userMsg = { from: 'user', text: msg, extra: null };
    const newMsgs = msgs.concat([userMsg]);
    setMsgs(newMsgs);
    await saveMessage(userMsg);
    setBusy(true);
    try {
      const result = await askClaude(msg, listings);
      let updatedListings = listings;
      if (result.listings) {
        updatedListings = result.listings;
        setListings(updatedListings);
        await saveAllListings(updatedListings);
        if (result.action === 'add') {
          showNotification('New stock added to database!');
        }
      }
      if (result.action === 'query' && result.results) {
        setMatches(result.results);
        setTab('stock');
      }
      if (result.action === 'add' || result.action === 'sell') setTab('stock');
      const aiMsg = { from: 'ai', text: result.message || 'Done.', extra: result.estimate || null };
      setMsgs(newMsgs.concat([aiMsg]));
      await saveMessage(aiMsg);
    } catch(e) {
      setErr(e.message || 'Unknown error');
      const errMsg = { from: 'ai', text: 'Error: ' + (e.message || 'Unknown error'), extra: null };
      setMsgs(newMsgs.concat([errMsg]));
    }
    setBusy(false);
  }

  async function handlePhoto(e) {
    const file = e.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      await uploadPhoto(file);
      showNotification('Photo uploaded! Mention it when adding stock.');
    } catch(e) {
      setErr('Photo upload failed: ' + e.message);
    }
    setBusy(false);
  }

  function exportData() {
    const json = JSON.stringify(listings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stockbossnz_export_' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
  }

  const available = listings.filter(function(l) { return l.status !== 'sold'; });
  const sold = listings.filter(function(l) { return l.status === 'sold'; });
  const categories = ['all'].concat([...new Set(available.map(function(l) { return l.category; }).filter(Boolean))]);

  let shown = matches
    ? listings.filter(function(l) { return matches.indexOf(l.id) !== -1; })
    : tab === 'sold' ? sold : available;

  if (tab === 'stock' && filterCat !== 'all') {
    shown = shown.filter(function(l) { return l.category === filterCat; });
  }

  const totalHead = available.reduce(function(a, l) { return a + (l.quantity - (l.quantitySold || 0)); }, 0);
  const soldWithPrice = sold.filter(function(l) { return l.pricePerHead; });
  const avgPrice = soldWithPrice.length > 0
    ? Math.round(soldWithPrice.reduce(function(a, l) { return a + l.pricePerHead; }, 0) / soldWithPrice.length)
    : null;

  if (loading) {
    return (
      <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8dcc8', fontSize: 18 }}>
        Loading StockBossNZ...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Georgia,serif', background: '#f5f0e8', minHeight: '100vh', display: 'flex', flexDirection: 'column', maxWidth: 900, margin: '0 auto' }}>

      {notification && (
        <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', background: '#27ae60', color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, fontWeight: 'bold', zIndex: 1000, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
          {notification}
        </div>
      )}

      <div style={{ background: '#1a2e1a', color: '#e8dcc8', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 24 }}>🐄</div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 'bold', letterSpacing: 1 }}>STOCKBOSSNZ</div>
          <div style={{ fontSize: 9, color: '#a0b89a', letterSpacing: 2 }}>SMART LIVESTOCK MATCHING</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: '#a0b89a', textAlign: 'right' }}>
          <div>{available.length + ' lots available'}</div>
          <div>{totalHead + ' head listed'}</div>
          {avgPrice && <div>{'avg sold $' + avgPrice + '/hd'}</div>}
        </div>
        <button onClick={exportData} style={{ marginLeft: 12, background: 'none', border: '1px solid #a0b89a', color: '#a0b89a', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>
          Export
        </button>
      </div>

      <div style={{ display: 'flex', background: '#2d4a2d', alignItems: 'center' }}>
        {[
          { k: 'chat', label: 'Chat' },
          { k: 'stock', label: 'Stock (' + available.length + ')' },
          { k: 'sold', label: 'Sold (' + sold.length + ')' },
          { k: 'dashboard', label: 'Dashboard' }
        ].map(function(t) {
          return (
            <button key={t.k} onClick={function() { setTab(t.k); setMatches(null); }} style={{
              background: tab === t.k ? '#f5f0e8' : 'transparent',
              color: tab === t.k ? '#1a2e1a' : '#c8d8c0',
              border: 'none', padding: '10px 16px', cursor: 'pointer',
              fontFamily: 'Georgia,serif', fontSize: 13,
              fontWeight: tab === t.k ? 'bold' : 'normal'
            }}>{t.label}</button>
          );
        })}
        {matches && (
          <div style={{ marginLeft: 'auto', padding: '10px 14px', color: '#f0d060', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            {matches.length + ' match' + (matches.length !== 1 ? 'es' : '')}
            <button onClick={function() { setMatches(null); }} style={{ background: 'none', border: 'none', color: '#f0d060', cursor: 'pointer', fontSize: 15 }}>x</button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {tab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {msgs.map(function(m, i) {
                const isUser = m.from === 'user';
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
                    <div style={{
                      maxWidth: '82%', background: isUser ? '#2d4a2d' : '#ffffff',
                      color: isUser ? '#e8dcc8' : '#222',
                      borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      padding: '10px 14px', fontSize: 14, lineHeight: 1.5,
                      border: isUser ? 'none' : '1px solid #ddd',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.07)'
                    }}>
                      {!isUser && <div style={{ fontSize: 9, color: '#aaa', marginBottom: 3, letterSpacing: 1 }}>STOCKBOSSNZ AI</div>}
                      {m.text}
                    </div>
                    {m.extra && (
                      <div style={{ maxWidth: '82%', marginTop: 6, background: '#1a2e1a', color: '#e8dcc8', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>
                        <div style={{ fontWeight: 'bold', marginBottom: 6, color: '#f0d060', letterSpacing: 0.5, fontSize: 11 }}>PRICE ESTIMATE</div>
                        <div style={{ display: 'flex', gap: 20, marginBottom: 8 }}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: '#a0b89a' }}>LOW</div>
                            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#74c69d' }}>{'$' + m.extra.low}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: '#a0b89a' }}>MID</div>
                            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#f0d060' }}>{'$' + m.extra.mid}</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: '#a0b89a' }}>HIGH</div>
                            <div style={{ fontSize: 22, fontWeight: 'bold', color: '#e8dcc8' }}>{'$' + m.extra.high}</div>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#a0b89a', lineHeight: 1.4 }}>{m.extra.reasoning}</div>
                      </div>
                    )}
                  </div>
                );
              })}
              {busy && (
                <div style={{ display: 'flex' }}>
                  <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: '14px 14px 14px 4px', padding: '10px 14px', color: '#aaa', fontSize: 13 }}>
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={bottom} />
            </div>

            {err && (
              <div style={{ margin: '0 18px 8px', padding: '9px 13px', background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 7, fontSize: 12, color: '#c00' }}>
                {'Error: ' + err}
              </div>
            )}

            <div style={{ padding: '0 18px 8px', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {[
                "What R2 steers are available?",
                "What would Angus R2 500kg cost?",
                "Show all heifers"
              ].map(function(q) {
                return (
                  <button key={q} onClick={function() { send(q); }} style={{
                    background: 'none', border: '1px solid #2d4a2d', color: '#2d4a2d',
                    borderRadius: 20, padding: '4px 11px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif'
                  }}>{q}</button>
                );
              })}
              <button onClick={function() { fileRef.current && fileRef.current.click(); }} style={{
                background: 'none', border: '1px solid #6d4c41', color: '#6d4c41',
                borderRadius: 20, padding: '4px 11px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif'
              }}>Upload photo</button>
              <input ref={fileRef} type="file" accept="image/*" onChange={handlePhoto} style={{ display: 'none' }} />
            </div>

            <div style={{ padding: '8px 18px 18px', display: 'flex', gap: 8 }}>
              <input
                value={input}
                onChange={function(e) { setInput(e.target.value); }}
                onKeyDown={function(e) { if (e.key === 'Enter') send(); }}
                placeholder="Type anything — add stock, search, mark sold, ask prices..."
                style={{
                  flex: 1, padding: '11px 14px', borderRadius: 9,
                  border: '2px solid #2d4a2d', fontFamily: 'Georgia,serif',
                  fontSize: 14, background: '#fff', outline: 'none', color: '#111'
                }}
              />
              <button onClick={function() { send(); }} disabled={busy || !input.trim()} style={{
                background: (busy || !input.trim()) ? '#999' : '#2d4a2d',
                color: '#e8dcc8', border: 'none', borderRadius: 9,
                padding: '11px 18px', cursor: (busy || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'Georgia,serif', fontSize: 14, fontWeight: 'bold'
              }}>Send</button>
            </div>
          </div>
        )}

        {(tab === 'stock' || tab === 'sold') && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {tab === 'stock' && categories.length > 1 && (
              <div style={{ display: 'flex', gap: 7, marginBottom: 12, flexWrap: 'wrap' }}>
                {categories.map(function(c) {
                  return (
                    <button key={c} onClick={function() { setFilterCat(c); }} style={{
                      background: filterCat === c ? (CAT_COLORS[c] || '#2d4a2d') : 'none',
                      color: filterCat === c ? '#fff' : '#555',
                      border: '1px solid ' + (CAT_COLORS[c] || '#2d4a2d'),
                      borderRadius: 20, padding: '4px 12px', fontSize: 12,
                      cursor: 'pointer', fontFamily: 'Georgia,serif', textTransform: 'capitalize'
                    }}>{c}</button>
                  );
                })}
              </div>
            )}

            {shown.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>
                {matches ? 'No matches found.' : tab === 'sold' ? 'Nothing sold yet.' : 'No stock listed. Use Chat to add some.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {shown.map(function(l) {
                  const badge = getBadge(l.status, l.quantity, l.quantitySold || 0);
                  const cc = CAT_COLORS[l.category] || '#78909c';
                  const rem = l.quantity - (l.quantitySold || 0);
                  return (
                    <div key={l.id} style={{
                      background: '#fff', borderRadius: 9, padding: '13px 16px',
                      border: '1px solid #ddd', boxShadow: '0 1px 5px rgba(0,0,0,0.05)',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      opacity: l.status === 'sold' ? 0.6 : 1,
                      borderLeft: '5px solid ' + cc
                    }}>
                      {l.photoUrl && (
                        <img src={l.photoUrl} alt="stock" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 7, flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#1a2e1a' }}>{l.seller}</span>
                          {l.sellerPhone && <span style={{ fontSize: 11, color: '#888' }}>{l.sellerPhone}</span>}
                          <span style={{ background: cc, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, textTransform: 'uppercase' }}>{l.category}</span>
                        </div>
                        <div style={{ fontSize: 14, color: '#333', marginBottom: 3 }}>
                          <strong>{l.breed}</strong>
                          {l.age ? (' - ' + l.age) : ''}
                          {l.weightKg ? (' - ' + l.weightKg + 'kg') : ''}
                          {l.condition ? (' - ' + l.condition) : ''}
                        </div>
                        {(l.location || l.trucking || l.nature) && (
                          <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>
                            {[l.location, l.nature, l.trucking].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: '#888' }}>
                          {l.pricePerHead ? (
                            <span style={{ color: '#2d6a4f', fontWeight: 'bold' }}>
                              {'$' + l.pricePerHead + '/hd'}
                              {l.centsPerKg ? (' (' + l.centsPerKg + 'c/kg)') : ''}
                            </span>
                          ) : (
                            <span style={{ color: '#bbb' }}>Price TBC</span>
                          )}
                          {l.notes ? ('  |  ' + l.notes) : ''}
                        </div>
                        {l.buyer && (
                          <div style={{ fontSize: 12, color: '#6d4c41', marginTop: 3 }}>
                            {'Buyer: ' + l.buyer + (l.buyerPhone ? (' - ' + l.buyerPhone) : '')}
                          </div>
                        )}
                        {l.dateSold && (
                          <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                            {'Sold ' + new Date(l.dateSold).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'center', minWidth: 60, flexShrink: 0 }}>
                        <div style={{ fontSize: 24, fontWeight: 'bold', color: '#1a2e1a', lineHeight: 1 }}>{rem}</div>
                        <div style={{ fontSize: 10, color: '#bbb' }}>{'of ' + l.quantity}</div>
                        {(l.quantitySold > 0) && <div style={{ fontSize: 10, color: '#e67e22' }}>{l.quantitySold + ' sold'}</div>}
                        <div style={{ background: badge.color, color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, fontWeight: 'bold', marginTop: 4 }}>{badge.label}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {shown.length > 0 && (
              <div style={{ marginTop: 14, padding: '11px 16px', background: '#1a2e1a', borderRadius: 7, color: '#e8dcc8', display: 'flex', gap: 18, fontSize: 12, flexWrap: 'wrap' }}>
                <span>{shown.length + ' lots'}</span>
                <span>{shown.reduce(function(a, l) { return a + (l.quantity - (l.quantitySold || 0)); }, 0) + ' head'}</span>
                {shown.some(function(l) { return l.pricePerHead; }) && (
                  <span>
                    {'$' + Math.min.apply(null, shown.filter(function(l) { return l.pricePerHead; }).map(function(l) { return l.pricePerHead; })) +
                    ' - $' + Math.max.apply(null, shown.filter(function(l) { return l.pricePerHead; }).map(function(l) { return l.pricePerHead; })) + '/hd'}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'dashboard' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Lots Available', value: available.length, color: '#27ae60' },
                { label: 'Head Available', value: totalHead, color: '#2d6a4f' },
                { label: 'Lots Sold', value: sold.length, color: '#c0392b' },
                { label: 'Head Sold', value: sold.reduce(function(a, l) { return a + (l.quantitySold || 0); }, 0), color: '#e67e22' },
                { label: 'Avg Price Sold', value: avgPrice ? ('$' + avgPrice) : 'N/A', color: '#8d6e63' },
                { label: 'Total Listings', value: listings.length, color: '#1b4332' }
              ].map(function(s) {
                return (
                  <div key={s.label} style={{ background: '#fff', borderRadius: 9, padding: '16px', border: '1px solid #ddd', borderTop: '4px solid ' + s.color }}>
                    <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
                    <div style={{ fontSize: 28, fontWeight: 'bold', color: s.color }}>{s.value}</div>
                  </div>
                );
              })}
            </div>

            <div style={{ background: '#fff', borderRadius: 9, padding: 16, border: '1px solid #ddd', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 12 }}>Stock by Category</div>
              {Object.keys(CAT_COLORS).map(function(cat) {
                const catListings = available.filter(function(l) { return l.category === cat; });
                if (catListings.length === 0) return null;
                const head = catListings.reduce(function(a, l) { return a + (l.quantity - (l.quantitySold || 0)); }, 0);
                return (
                  <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: CAT_COLORS[cat], flexShrink: 0 }}></div>
                    <div style={{ fontSize: 13, color: '#333', textTransform: 'capitalize', width: 80 }}>{cat}</div>
                    <div style={{ flex: 1, background: '#f0ede8', borderRadius: 4, height: 8 }}>
                      <div style={{ width: Math.min(100, (head / Math.max(totalHead, 1)) * 100) + '%', background: CAT_COLORS[cat], height: 8, borderRadius: 4 }}></div>
                    </div>
                    <div style={{ fontSize: 12, color: '#888', width: 60, textAlign: 'right' }}>{head + ' head'}</div>
                  </div>
                );
              })}
            </div>

            {soldWithPrice.length > 0 && (
              <div style={{ background: '#fff', borderRadius: 9, padding: 16, border: '1px solid #ddd' }}>
                <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 12 }}>Recent Sales</div>
                {soldWithPrice.slice(0, 8).map(function(l) {
                  return (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0ede8' }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLORS[l.category] || '#78909c', flexShrink: 0 }}></div>
                      <div style={{ flex: 1, fontSize: 13, color: '#333' }}>
                        {l.seller + ' - ' + l.breed + (l.age ? ' ' + l.age : '')}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 'bold', color: '#2d6a4f' }}>{'$' + l.pricePerHead + '/hd'}</div>
                      <div style={{ fontSize: 11, color: '#bbb' }}>{l.quantitySold + ' hd'}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
