import { useState, useRef, useEffect } from 'react';
import { getListings, saveAllListings, getMessages, saveMessage, uploadPhoto, deleteListing, getBuyers, saveBuyer, deleteBuyer, signIn, signUp, signOut, getSession, supabase } from './supabase';

const SYSTEM_PROMPT = `You are StockBossNZ, a smart livestock matching AI for stock agents in New Zealand and Australia. Respond ONLY with raw JSON, no markdown, no backticks, no explanation.

JSON shape:
{
  "action": "add_stock" or "sell_stock" or "query_stock" or "add_buyer" or "query_buyers" or "price_estimate" or "chat",
  "message": "plain English reply",
  "listings": [ full updated listings array - only when action is add_stock or sell_stock ],
  "buyers": [ full updated buyers array - only when action is add_buyer ],
  "results": [ matching listing ids - only when action is query_stock ],
  "buyer_results": [ matching buyer ids - only when action is query_buyers ],
  "estimate": { "low": number, "mid": number, "high": number, "reasoning": "string" } - only when action is price_estimate
}

Stock listing shape:
{
  "id": "lst_" plus unix timestamp,
  "seller": "name",
  "sellerPhone": "phone or null",
  "buyer": "buyer name if sold or null",
  "buyerPhone": "phone or null",
  "breed": "e.g. Angus, Friesian, Hereford, Merino",
  "category": "steers or heifers or cows or bulls or calves or ewes or rams or lambs or wethers or other",
  "age": "e.g. R2, R3, Weaner",
  "weightKg": number or null,
  "condition": "e.g. Good, Store, Fat",
  "location": "town or property",
  "trucking": "notes or null",
  "nature": "e.g. quiet, PTIC or null",
  "quantity": number,
  "quantitySold": number,
  "pricePerHead": number or null,
  "centsPerKg": number or null,
  "notes": "any info or null",
  "photoUrl": null,
  "dateAdded": "ISO string",
  "dateSold": null or "ISO string",
  "status": "available or partial or sold or matched"
}

Buyer request shape:
{
  "id": "buy_" plus unix timestamp,
  "name": "buyer name",
  "phone": "phone or null",
  "breed": "e.g. Angus",
  "category": "steers or heifers etc",
  "age": "e.g. R2 or null",
  "quantity": number or null,
  "maxPricePerHead": number or null,
  "notes": "any info or null",
  "dateAdded": "ISO string",
  "weightKg": number or null,
  "status": "looking or matched or inactive"
}

Rules:
- add_stock: new listing from seller info
- sell_stock: mark stock as sold or partial, update quantitySold, dateSold, buyer info
- query_stock: find available/partial/matched listings matching request - quantity is flexible, partial matches are fine
- add_buyer: new buyer request
- query_buyers: find looking buyers that match available stock
- price_estimate: estimate from sold listings history, use actualSalePrice if available as it is more accurate than pricePerHead
- Always return FULL array on add/sell/update actions
- Be flexible with quantity matching - buyer wanting 60 from a mob of 100 is still a match
- Extract as much detail as possible from natural language`;

const CAT_COLORS = {
  steers: '#2d6a4f', heifers: '#40916c', cows: '#52b788',
  bulls: '#1b4332', calves: '#74c69d', ewes: '#6d4c41',
  rams: '#4e342e', lambs: '#a1887f', wethers: '#8d6e63', other: '#78909c'
};

function getBadge(status) {
  if (status === 'sold') return { label: 'SOLD', color: '#c0392b' };
  if (status === 'matched') return { label: 'MATCHED', color: '#8e44ad' };
  if (status === 'partial') return { label: 'PARTIAL', color: '#e67e22' };
  return { label: 'AVAILABLE', color: '#27ae60' };
}

async function askClaude(userMsg, listings, buyers) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: 'Date: ' + new Date().toISOString() + '\nStock: ' + JSON.stringify(listings) + '\nBuyers: ' + JSON.stringify(buyers) + '\n\nMessage: ' + userMsg
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

function findMatches(listings, buyers) {
  var matches = [];
  buyers.filter(function(b) { return b.status === 'looking'; }).forEach(function(buyer) {
    listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; }).forEach(function(listing) {
      if (!buyer.category || !listing.category || buyer.category !== listing.category) return;
      var score = 0;
      if (buyer.weightKg && listing.weightKg) {
        var diff = Math.abs(buyer.weightKg - listing.weightKg);
        if (diff <= 70) score += Math.round(3 * (1 - diff / 70));
      }
      if (buyer.age && listing.age && listing.age.toLowerCase().includes(buyer.age.toLowerCase())) score += 3;
      if (buyer.breed && listing.breed && listing.breed.toLowerCase().includes(buyer.breed.toLowerCase())) score += 2;
      if (score === 0 && !buyer.weightKg && !buyer.age && !buyer.breed) score = 1;
      matches.push({ buyerId: buyer.id, listingId: listing.id, score: score, buyer: buyer, listing: listing });
    });
  });
  matches.sort(function(a, b) { return b.score - a.score; });
  return matches;
}

function AuthScreen() {
  var [mode, setMode] = useState('login');
  var [email, setEmail] = useState('');
  var [password, setPassword] = useState('');
  var [busy, setBusy] = useState(false);
  var [err, setErr] = useState(null);
  var [done, setDone] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !password.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'login') {
        await signIn(email.trim(), password.trim());
      } else {
        await signUp(email.trim(), password.trim());
        setDone(true);
      }
    } catch(e) {
      setErr(e.message || 'Something went wrong');
    }
    setBusy(false);
  }

  if (done) {
    return (
      <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Check your email</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 16, lineHeight: 1.6 }}>
            We have sent a confirmation link to <strong>{email}</strong>. Click the link to verify your email, then wait for an admin to approve your account.
          </div>
          <button onClick={function() { setDone(false); setMode('login'); }} style={{ background: '#2d4a2d', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 380, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🐄</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#1a2e1a', letterSpacing: 1 }}>STOCKBOSSNZ</div>
          <div style={{ fontSize: 10, color: '#a0b89a', letterSpacing: 2 }}>SMART LIVESTOCK MATCHING</div>
        </div>

        <div style={{ display: 'flex', marginBottom: 24, background: '#f5f0e8', borderRadius: 8, padding: 4 }}>
          <button onClick={function() { setMode('login'); setErr(null); }} style={{
            flex: 1, padding: '8px', border: 'none', borderRadius: 6, cursor: 'pointer',
            fontFamily: 'Georgia,serif', fontSize: 13, fontWeight: 'bold',
            background: mode === 'login' ? '#2d4a2d' : 'transparent',
            color: mode === 'login' ? '#fff' : '#666'
          }}>Log In</button>
          <button onClick={function() { setMode('signup'); setErr(null); }} style={{
            flex: 1, padding: '8px', border: 'none', borderRadius: 6, cursor: 'pointer',
            fontFamily: 'Georgia,serif', fontSize: 13, fontWeight: 'bold',
            background: mode === 'signup' ? '#2d4a2d' : 'transparent',
            color: mode === 'signup' ? '#fff' : '#666'
          }}>Sign Up</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Email</div>
          <input
            value={email}
            onChange={function(e) { setEmail(e.target.value); }}
            onKeyDown={function(e) { if (e.key === 'Enter') handleSubmit(); }}
            type="email"
            placeholder="your@email.com"
            style={{ width: '100%', padding: '10px 12px', border: '2px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Password</div>
          <input
            value={password}
            onChange={function(e) { setPassword(e.target.value); }}
            onKeyDown={function(e) { if (e.key === 'Enter') handleSubmit(); }}
            type="password"
            placeholder="••••••••"
            style={{ width: '100%', padding: '10px 12px', border: '2px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>

        {err && (
          <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 7, padding: '9px 13px', fontSize: 12, color: '#c00', marginBottom: 16 }}>
            {err}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={busy || !email.trim() || !password.trim()}
          style={{
            width: '100%', padding: '12px', border: 'none', borderRadius: 8,
            background: (busy || !email.trim() || !password.trim()) ? '#999' : '#2d4a2d',
            color: '#fff', cursor: (busy || !email.trim() || !password.trim()) ? 'not-allowed' : 'pointer',
            fontFamily: 'Georgia,serif', fontSize: 15, fontWeight: 'bold'
          }}
        >
          {busy ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Sign Up'}
        </button>

        {mode === 'signup' && (
          <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
            After signing up you will need to confirm your email and wait for admin approval before accessing the app.
          </div>
        )}
      </div>
    </div>
  );
}

function PendingScreen({ onSignOut }) {
  return (
    <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Awaiting Approval</div>
        <div style={{ fontSize: 14, color: '#666', marginBottom: 24, lineHeight: 1.6 }}>
          Your account is pending approval from an admin. You will be able to access StockBossNZ once approved.
        </div>
        <button onClick={onSignOut} style={{ background: 'none', border: '1px solid #ccc', color: '#666', borderRadius: 8, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

export default function App() {
  var [session, setSession] = useState(null);
  var [authLoading, setAuthLoading] = useState(true);
  var [listings, setListings] = useState([]);
  var [buyers, setBuyers] = useState([]);
  var [msgs, setMsgs] = useState([]);
  var [input, setInput] = useState('');
  var [busy, setBusy] = useState(false);
  var [tab, setTab] = useState('chat');
  var [err, setErr] = useState(null);
  var [loading, setLoading] = useState(true);
  var [notification, setNotification] = useState(null);
  var [confirmDelete, setConfirmDelete] = useState(null);
  var [confirmDeleteBuyer, setConfirmDeleteBuyer] = useState(null);
  var [sellModal, setSellModal] = useState(null);
  var [sellQty, setSellQty] = useState('');
  var [sellBuyer, setSellBuyer] = useState('');
  var [sellPrice, setSellPrice] = useState('');
  var [filterCat, setFilterCat] = useState('all');
  var [dismissedMatches, setDismissedMatches] = useState([]);
  var bottom = useRef(null);
  var fileRef = useRef(null);

  useEffect(function() {
    getSession().then(function(s) {
      setSession(s);
      setAuthLoading(false);
    });
    var listener = supabase.auth.onAuthStateChange(function(event, s) {
      setSession(s);
    });
    return function() { listener.data.subscription.unsubscribe(); };
  }, []);

  useEffect(function() {
    if (!session) return;
    async function load() {
      try {
        var results = await Promise.all([getListings(), getBuyers(), getMessages()]);
        var ls = results[0];
        var bs = results[1];
        var ms = results[2];
        var mapped = ls.map(function(l) {
          return {
            id: l.id, seller: l.seller, sellerPhone: l.seller_phone,
            buyer: l.buyer, buyerPhone: l.buyer_phone,
            breed: l.breed, category: l.category,
            age: l.age, weightKg: l.weight_kg, condition: l.condition,
            location: l.location, trucking: l.trucking, nature: l.nature,
            quantity: l.quantity, quantitySold: l.quantity_sold,
            pricePerHead: l.price_per_head, centsPerKg: l.cents_per_kg,
            actualSalePrice: l.actual_sale_price,
            notes: l.notes, photoUrl: l.photo_url,
            dateAdded: l.date_added, dateSold: l.date_sold, status: l.status
          };
        });
        var mappedBuyers = bs.map(function(b) {
          return {
            id: b.id, name: b.name, phone: b.phone,
            breed: b.breed, category: b.category, age: b.age,
            quantity: b.quantity, weightKg: b.weight_kg || null, maxPricePerHead: b.max_price_per_head,
            notes: b.notes, dateAdded: b.date_added, status: b.status
          };
        });
        setListings(mapped);
        setBuyers(mappedBuyers);
        if (ms.length > 0) {
          setMsgs(ms);
        } else {
          setMsgs([{ from: 'ai', text: "G'day! I'm StockBossNZ. Tell me what stock is for sale — e.g. 'Pete has 80 Angus R2 steers, $1100/hd Hawkes Bay' — or add a buyer — e.g. 'Johnson looking for 60 Friesian R2 steers up to $900'. I'll find matches automatically!", extra: null }]);
        }
      } catch(e) {
        setErr('Could not load: ' + e.message);
      }
      setLoading(false);
    }
    load();
  }, [session]);

  useEffect(function() {
    if (bottom.current) bottom.current.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  async function handleSignOut() {
    await signOut();
    setSession(null);
    setListings([]);
    setBuyers([]);
    setMsgs([]);
  }

  function showNotification(text) {
    setNotification(text);
    setTimeout(function() { setNotification(null); }, 4000);
  }

  async function send(overrideInput) {
    var msg = (overrideInput || input).trim();
    if (!msg || busy) return;
    setInput('');
    setErr(null);
    var userMsg = { from: 'user', text: msg, extra: null };
    var newMsgs = msgs.concat([userMsg]);
    setMsgs(newMsgs);
    await saveMessage(userMsg);
    setBusy(true);
    try {
      var result = await askClaude(msg, listings, buyers);
      var updatedListings = listings;
      var updatedBuyers = buyers;
      if (result.listings) {
        updatedListings = result.listings;
        setListings(updatedListings);
        await saveAllListings(updatedListings);
      }
      if (result.buyers) {
        updatedBuyers = result.buyers;
        setBuyers(updatedBuyers);
        for (var i = 0; i < updatedBuyers.length; i++) {
          await saveBuyer(updatedBuyers[i]);
        }
      }
      if (result.action === 'add_stock') {
        showNotification('Stock added!');
        setTab('stock');
        var matches = findMatches(updatedListings, updatedBuyers);
        if (matches.length > 0) {
          var matchMsg = { from: 'ai', text: 'Heads up! Found ' + matches.length + ' potential match' + (matches.length > 1 ? 'es' : '') + ' with buyers on your list. Check the Matches tab!', extra: null };
          newMsgs = newMsgs.concat([{ from: 'ai', text: result.message || 'Done.', extra: result.estimate || null }]);
          setMsgs(newMsgs.concat([matchMsg]));
          await saveMessage(matchMsg);
          setBusy(false);
          return;
        }
      }
      if (result.action === 'add_buyer') {
        showNotification('Buyer added!');
        setTab('buyers');
        var matches2 = findMatches(updatedListings, updatedBuyers);
        if (matches2.length > 0) {
          var matchMsg2 = { from: 'ai', text: 'Great news! Found ' + matches2.length + ' potential match' + (matches2.length > 1 ? 'es' : '') + ' in current stock. Check the Matches tab!', extra: null };
          newMsgs = newMsgs.concat([{ from: 'ai', text: result.message || 'Done.', extra: null }]);
          setMsgs(newMsgs.concat([matchMsg2]));
          await saveMessage(matchMsg2);
          setBusy(false);
          return;
        }
      }
      if (result.action === 'sell_stock') setTab('sold');
      var aiMsg = { from: 'ai', text: result.message || 'Done.', extra: result.estimate || null };
      setMsgs(newMsgs.concat([aiMsg]));
      await saveMessage(aiMsg);
    } catch(e) {
      setErr(e.message || 'Unknown error');
      setMsgs(newMsgs.concat([{ from: 'ai', text: 'Error: ' + (e.message || 'Unknown error'), extra: null }]));
    }
    setBusy(false);
  }

  async function handlePhoto(e) {
    var file = e.target.files[0];
    if (!file) return;
    setBusy(true);
    try {
      await uploadPhoto(file);
      showNotification('Photo uploaded!');
    } catch(e) {
      setErr('Upload failed: ' + e.message);
    }
    setBusy(false);
  }

  function exportData() {
    var json = JSON.stringify({ listings: listings, buyers: buyers }, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'stockbossnz_export_' + new Date().toISOString().split('T')[0] + '.json';
    a.click();
  }

  async function handleDeleteListing(id) {
    try {
      await deleteListing(id);
      setListings(listings.filter(function(l) { return l.id !== id; }));
      setConfirmDelete(null);
      showNotification('Listing deleted.');
    } catch(e) {
      setErr('Delete failed: ' + e.message);
    }
  }

  async function handleDeleteBuyer(id) {
    try {
      await deleteBuyer(id);
      setBuyers(buyers.filter(function(b) { return b.id !== id; }));
      setConfirmDeleteBuyer(null);
      showNotification('Buyer request deleted.');
    } catch(e) {
      setErr('Delete failed: ' + e.message);
    }
  }

  async function markMatched(listing) {
    var updated = listings.map(function(l) {
      return l.id === listing.id ? Object.assign({}, l, { status: 'matched' }) : l;
    });
    setListings(updated);
    await saveAllListings(updated);
    showNotification('Moved to In Talks!');
  }

  async function reList(listing) {
    var updated = listings.map(function(l) {
      return l.id === listing.id ? Object.assign({}, l, { status: 'available' }) : l;
    });
    setListings(updated);
    await saveAllListings(updated);
    showNotification('Re-listed as available!');
  }

  async function saveSell() {
    if (!sellModal) return;
    var rem = sellModal.quantity - (sellModal.quantitySold || 0);
    var qty = sellQty ? parseInt(sellQty) : rem;
    if (isNaN(qty) || qty <= 0) qty = rem;
    if (qty > rem) qty = rem;
    var newSold = (sellModal.quantitySold || 0) + qty;
    var newStatus = newSold >= sellModal.quantity ? 'sold' : 'partial';
    var updated = listings.map(function(l) {
      if (l.id !== sellModal.id) return l;
      return Object.assign({}, l, {
        quantitySold: newSold,
        buyer: sellBuyer || l.buyer || null,
        actualSalePrice: sellPrice ? parseFloat(sellPrice) : null,
        dateSold: new Date().toISOString(),
        status: newStatus
      });
    });
    setListings(updated);
    await saveAllListings(updated);
    setSellModal(null);
    setSellQty('');
    setSellBuyer('');
    setSellPrice('');
    showNotification(qty + ' head marked as sold!');
    setTab('sold');
  }

  if (authLoading) {
    return (
      <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8dcc8', fontSize: 18 }}>
        Loading...
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  if (!session.user.email_confirmed_at) {
    return <PendingScreen onSignOut={handleSignOut} />;
  }

  var available = listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; });
  var matched = listings.filter(function(l) { return l.status === 'matched'; });
  var sold = listings.filter(function(l) { return l.status === 'sold'; });
  var activeBuyers = buyers.filter(function(b) { return b.status === 'looking'; });
  var allMatches = findMatches(listings, buyers).filter(function(m) {
    return !dismissedMatches.some(function(d) { return d.buyerId === m.buyerId && d.listingId === m.listingId; });
  });
  var categories = ['all'].concat([...new Set(available.map(function(l) { return l.category; }).filter(Boolean))]);

  var shownStock = tab === 'sold' ? sold : tab === 'matched' ? matched : available;
  if ((tab === 'stock' || tab === 'matched') && filterCat !== 'all') {
    shownStock = shownStock.filter(function(l) { return l.category === filterCat; });
  }

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

      {confirmDelete && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 340, width: '100%' }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Delete this listing?</div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>This cannot be undone.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={function() { setConfirmDelete(null); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
              <button onClick={function() { handleDeleteListing(confirmDelete); }} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#c0392b', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteBuyer && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 340, width: '100%' }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Delete this buyer request?</div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>This cannot be undone.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={function() { setConfirmDeleteBuyer(null); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
              <button onClick={function() { handleDeleteBuyer(confirmDeleteBuyer); }} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#c0392b', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {sellModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%' }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>Mark as Sold</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{sellModal.seller + ' - ' + sellModal.breed + (sellModal.age ? ' ' + sellModal.age : '')}</div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>{'How many head sold? (blank = all ' + (sellModal.quantity - (sellModal.quantitySold || 0)) + ' remaining)'}</div>
            <input
              value={sellQty}
              onChange={function(e) { setSellQty(e.target.value); }}
              type="number"
              placeholder={'All ' + (sellModal.quantity - (sellModal.quantitySold || 0)) + ' head'}
              style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>Buyer name and/or phone (optional):</div>
            <input
              value={sellBuyer}
              onChange={function(e) { setSellBuyer(e.target.value); }}
              placeholder="e.g. Johnson 0421 234 567"
              style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Actual sale price per head:</div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>{'Listed at ' + (sellModal.pricePerHead ? '$' + sellModal.pricePerHead + '/hd' : 'no price') + ' — what did it actually sell for?'}</div>
            <input
              value={sellPrice}
              onChange={function(e) { setSellPrice(e.target.value); }}
              type="number"
              placeholder={sellModal.pricePerHead ? String(sellModal.pricePerHead) : 'e.g. 950'}
              style={{ width: '100%', padding: '10px', border: '2px solid #2d6a4f', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 20, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={function() { setSellModal(null); setSellQty(''); setSellBuyer(''); setSellPrice(''); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
              <button onClick={saveSell} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#2d4a2d', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Mark Sold</button>
            </div>
          </div>
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
          <div>{activeBuyers.length + ' buyers looking'}</div>
          {allMatches.length > 0 && <div style={{ color: '#f0d060' }}>{allMatches.length + ' matches!'}</div>}
        </div>
        <button onClick={exportData} style={{ marginLeft: 8, background: 'none', border: '1px solid #a0b89a', color: '#a0b89a', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Export</button>
        <button onClick={handleSignOut} style={{ background: 'none', border: '1px solid #a0b89a', color: '#a0b89a', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Log Out</button>
      </div>

      <div style={{ display: 'flex', background: '#2d4a2d', alignItems: 'center', overflowX: 'auto', position: 'sticky', top: 0, zIndex: 100 }}>
        {[
          { k: 'chat', label: 'Chat' },
          { k: 'stock', label: 'Sellers (' + available.length + ')' },
          { k: 'buyers', label: 'Buyers (' + activeBuyers.length + ')' },
          { k: 'matches', label: 'Matches (' + allMatches.length + ')' },
          { k: 'matched', label: 'In Talks (' + matched.length + ')' },
          { k: 'sold', label: 'Sold (' + sold.length + ')' }
        ].map(function(t) {
          return (
            <button key={t.k} onClick={function() { setTab(t.k); }} style={{
              background: tab === t.k ? '#f5f0e8' : 'transparent',
              color: tab === t.k ? '#1a2e1a' : '#c8d8c0',
              border: 'none', padding: '10px 14px', cursor: 'pointer',
              fontFamily: 'Georgia,serif', fontSize: 12, whiteSpace: 'nowrap',
              fontWeight: tab === t.k ? 'bold' : 'normal'
            }}>{t.label}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {tab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {msgs.map(function(m, i) {
                var isUser = m.from === 'user';
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
                        <div style={{ fontWeight: 'bold', marginBottom: 6, color: '#f0d060', fontSize: 11 }}>PRICE ESTIMATE</div>
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
                "Johnson looking for 60 Angus R2 steers",
                "What would Angus R2 500kg cost?"
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
                placeholder="Add stock, add buyer, search, mark sold, ask prices..."
                style={{ flex: 1, padding: '11px 14px', borderRadius: 9, border: '2px solid #2d4a2d', fontFamily: 'Georgia,serif', fontSize: 14, background: '#fff', outline: 'none', color: '#111' }}
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

        {(tab === 'stock' || tab === 'matched' || tab === 'sold') && (
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
            {shownStock.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>
                {tab === 'sold' ? 'Nothing sold yet.' : tab === 'matched' ? 'No stock in talks yet.' : 'No stock listed. Use Chat to add some.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {shownStock.map(function(l) {
                  var badge = getBadge(l.status);
                  var cc = CAT_COLORS[l.category] || '#78909c';
                  var rem = l.quantity - (l.quantitySold || 0);
                  return (
                    <div key={l.id} style={{
                      background: '#fff', borderRadius: 9, padding: '13px 16px',
                      border: '1px solid #ddd', boxShadow: '0 1px 5px rgba(0,0,0,0.05)',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      opacity: l.status === 'sold' ? 0.65 : 1,
                      borderLeft: '5px solid ' + cc
                    }}>
                      {l.photoUrl && <img src={l.photoUrl} alt="stock" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 7, flexShrink: 0 }} />}
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
                        {(l.location || l.nature || l.trucking) && (
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
                          ) : <span style={{ color: '#bbb' }}>Price TBC</span>}
                          {l.notes ? ('  |  ' + l.notes) : ''}
                        </div>
                        {l.buyer && <div style={{ fontSize: 12, color: '#6d4c41', marginTop: 3 }}>{'Buyer: ' + l.buyer + (l.buyerPhone ? ' - ' + l.buyerPhone : '')}</div>}
                        {l.actualSalePrice && (
                          <div style={{ fontSize: 12, marginTop: 3 }}>
                            <span style={{ color: '#aaa' }}>{'Listed: $' + (l.pricePerHead || 'TBC') + ' -> '}</span>
                            <span style={{ color: '#2d6a4f', fontWeight: 'bold' }}>{'Sold: $' + l.actualSalePrice + '/hd'}</span>
                          </div>
                        )}
                        {l.dateSold && <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{'Sold ' + new Date(l.dateSold).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</div>}
                      </div>
                      <div style={{ textAlign: 'center', minWidth: 64, flexShrink: 0 }}>
                        <div style={{ fontSize: 22, fontWeight: 'bold', color: '#1a2e1a', lineHeight: 1 }}>{rem}</div>
                        <div style={{ fontSize: 10, color: '#bbb' }}>{'of ' + l.quantity}</div>
                        {l.quantitySold > 0 && <div style={{ fontSize: 10, color: '#e67e22' }}>{l.quantitySold + ' sold'}</div>}
                        <div style={{ background: badge.color, color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, fontWeight: 'bold', marginTop: 4 }}>{badge.label}</div>
                        {(tab === 'stock' || tab === 'matched') && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                            {tab === 'stock' && (
                              <button onClick={function() { markMatched(l); }} style={{ background: '#8e44ad', border: 'none', color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, cursor: 'pointer', fontWeight: 'bold' }}>IN TALKS</button>
                            )}
                            {tab === 'matched' && (
                              <button onClick={function() { reList(l); }} style={{ background: '#2980b9', border: 'none', color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, cursor: 'pointer', fontWeight: 'bold' }}>RE-LIST</button>
                            )}
                            <button onClick={function() { setSellModal(l); }} style={{ background: '#2d6a4f', border: 'none', color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, cursor: 'pointer', fontWeight: 'bold' }}>SOLD</button>
                            <button onClick={function() { setConfirmDelete(l.id); }} style={{ background: 'none', border: '1px solid #c0392b', color: '#c0392b', borderRadius: 5, padding: '2px 6px', fontSize: 9, cursor: 'pointer' }}>DELETE</button>
                          </div>
                        )}
                        {tab === 'sold' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                            <button onClick={function() { setConfirmDelete(l.id); }} style={{ background: 'none', border: '1px solid #c0392b', color: '#c0392b', borderRadius: 5, padding: '2px 6px', fontSize: 9, cursor: 'pointer' }}>DELETE</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'buyers' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {activeBuyers.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>
                No buyers yet. Use Chat to add one — e.g. "Johnson looking for 60 Angus R2 steers up to $900"
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeBuyers.map(function(b) {
                  var cc = CAT_COLORS[b.category] || '#78909c';
                  var buyerMatches = allMatches.filter(function(m) { return m.buyerId === b.id; });
                  return (
                    <div key={b.id} style={{
                      background: '#fff', borderRadius: 9, padding: '13px 16px',
                      border: '1px solid #ddd', boxShadow: '0 1px 5px rgba(0,0,0,0.05)',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      borderLeft: '5px solid ' + (buyerMatches.length > 0 ? '#f0d060' : cc)
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#1a2e1a' }}>{b.name}</span>
                          {b.phone && <span style={{ fontSize: 11, color: '#888' }}>{b.phone}</span>}
                          {b.category && <span style={{ background: cc, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, textTransform: 'uppercase' }}>{b.category}</span>}
                          {buyerMatches.length > 0 && <span style={{ background: '#f0d060', color: '#1a2e1a', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 'bold' }}>{buyerMatches.length + ' MATCH' + (buyerMatches.length > 1 ? 'ES' : '')}</span>}
                        </div>
                        <div style={{ fontSize: 14, color: '#333', marginBottom: 3 }}>
                          {'Looking for: '}
                          <strong>{b.breed || 'Any breed'}</strong>
                          {b.age ? (' - ' + b.age) : ''}
                          {b.quantity ? (' - ' + b.quantity + ' head') : ''}
                        </div>
                        {b.maxPricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f', fontWeight: 'bold' }}>{'Up to $' + b.maxPricePerHead + '/hd'}</div>}
                        {b.notes && <div style={{ fontSize: 12, color: '#888' }}>{b.notes}</div>}
                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{'Added ' + new Date(b.dateAdded).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                        {buyerMatches.length > 0 && (
                          <button onClick={function() { setTab('matches'); }} style={{ background: '#f0d060', border: 'none', color: '#1a2e1a', borderRadius: 5, padding: '4px 8px', fontSize: 10, cursor: 'pointer', fontWeight: 'bold' }}>VIEW MATCHES</button>
                        )}
                        <button onClick={function() { setConfirmDeleteBuyer(b.id); }} style={{ background: 'none', border: '1px solid #c0392b', color: '#c0392b', borderRadius: 5, padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>DELETE</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'matches' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {allMatches.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>
                No matches yet. Add stock and buyers and I will find matches automatically!
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {allMatches.map(function(m, i) {
                  return (
                    <div key={i} style={{ background: '#fff', borderRadius: 9, border: '2px solid #f0d060', boxShadow: '0 2px 8px rgba(240,208,96,0.2)', overflow: 'hidden' }}>
                      <div style={{ background: '#f0d060', padding: '8px 16px', fontSize: 12, fontWeight: 'bold', color: '#1a2e1a' }}>
                        {'POTENTIAL MATCH — Score: ' + m.score + '/8'}
                      </div>
                      <div style={{ display: 'flex' }}>
                        <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid #f0ede8' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>SELLER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{m.listing.seller}</div>
                          <div style={{ fontSize: 13, color: '#333' }}>
                            <strong>{m.listing.breed}</strong>
                            {m.listing.age ? ' ' + m.listing.age : ''}
                          </div>
                          <div style={{ fontSize: 12, color: '#888' }}>{m.listing.quantity + ' head'}</div>
                          {m.listing.pricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f', fontWeight: 'bold' }}>{'$' + m.listing.pricePerHead + '/hd'}</div>}
                          {m.listing.location && <div style={{ fontSize: 11, color: '#aaa' }}>{m.listing.location}</div>}
                        </div>
                        <div style={{ flex: 1, padding: '12px 16px' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>BUYER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{m.buyer.name}</div>
                          {m.buyer.phone && <div style={{ fontSize: 12, color: '#888' }}>{m.buyer.phone}</div>}
                          <div style={{ fontSize: 12, color: '#333' }}>{'Wants: ' + (m.buyer.quantity ? m.buyer.quantity + ' head' : 'flexible')}</div>
                          {m.buyer.maxPricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f' }}>{'Up to $' + m.buyer.maxPricePerHead + '/hd'}</div>}
                        </div>
                      </div>
                      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0ede8', display: 'flex', gap: 8 }}>
                        <button onClick={function() { markMatched(m.listing); }} style={{ flex: 1, padding: '8px', background: '#8e44ad', border: 'none', color: '#fff', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold' }}>IN TALKS</button>
                        <button onClick={function() { setSellModal(m.listing); }} style={{ flex: 1, padding: '8px', background: '#2d6a4f', border: 'none', color: '#fff', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold' }}>MARK SOLD</button>
                        <button onClick={function() { setDismissedMatches(dismissedMatches.concat([{ buyerId: m.buyer.id, listingId: m.listing.id }])); }} style={{ flex: 1, padding: '8px', background: 'none', border: '1px solid #999', color: '#999', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12 }}>DISMISS</button>
                      </div>
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
