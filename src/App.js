import { useState, useRef, useEffect } from 'react';
import { getListings, saveAllListings, getMessages, saveMessage, uploadPhoto, deleteListing, getBuyers, saveBuyer, deleteBuyer, signIn, signUp, signOut, getSession, supabase, saveMarketData, clearMarketData, getMarketData, getDismissedMatches, saveDismissedMatch, deleteDismissedMatch, cleanupDismissedMatches } from './supabase';

const ADMIN_EMAIL = 'celia.bee@hotmail.com';
const ADMIN_PASSWORD = 'stockboss2024';
const FARM_PHOTO_URL = 'https://nnbmafrcosibaubzkkaf.supabase.co/storage/v1/object/public/Assets/farm.jpg';

const PRICE_KEYWORDS = ['worth', 'price', 'estimate', 'value', 'how much', 'what would', 'per head', 'per kg', 'cents', 'dollar'];

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
  "status": "available or partial or sold or matched or inactive"
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
  "status": "looking or matched or inactive or sold or in_talks"
}

MINIMUM DATA REQUIREMENTS:
Before saving any stock listing or buyer request, you MUST have at least these fields:
1. name (seller or buyer name)
2. age (e.g. R2, weaner, R3, mixed age)
3. category/sex (steers, heifers, cows, bulls, calves etc)
4. weightKg - EXCEPT if age is "mixed age" or "mixed" in which case weightKg can be null (set notes to "mixed age - any weight")

If any of these are missing, do NOT save. Instead set action to "chat" and ask specifically for what is missing.
Special rule: If age contains "mixed", set weightKg to null and add "mixed age - any weight" to notes.

Rules:
- add_stock: new listing from seller info
- sell_stock: mark stock as sold or partial, update quantitySold, dateSold, buyer info
- query_stock: find available/partial/matched listings matching request - ONLY return listings where category AND age match exactly what was asked. Do not return other categories or ages. Quantity is flexible but category and age must match exactly.
- add_buyer: new buyer request
- query_buyers: find looking buyers that match available stock
- price_estimate: estimate using BOTH sold listings history (actualSalePrice preferred) AND the MarketData reference data which contains recent NZ saleyard results. Use MarketData to find matching class, sub_class and weight_range_kg and give accurate low/mid/high estimates. In your reasoning refer to results as "recent NZ saleyard data" or "recent market results" - do not mention specific sale companies by name.
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
  if (status === 'inactive') return { label: 'INACTIVE', color: '#999' };
  if (status === 'in_talks') return { label: 'IN TALKS', color: '#8e44ad' };
  return { label: 'AVAILABLE', color: '#27ae60' };
}

function isPriceQuery(msg) {
  var lower = msg.toLowerCase();
  return PRICE_KEYWORDS.some(function(k) { return lower.includes(k); });
}

async function askClaude(userMsg, listings, buyers, history, marketData) {
  var contextPrefix = 'Date: ' + new Date().toISOString() + '\nStock: ' + JSON.stringify(listings) + '\nBuyers: ' + JSON.stringify(buyers);
  if (marketData && marketData.length > 0) {
    contextPrefix += '\nMarketData: ' + JSON.stringify(marketData);
  }
  contextPrefix += '\n\n';
  var messages = [];
  if (history && history.length > 0) {
    var recent = history.slice(-10);
    recent.forEach(function(m) {
      messages.push({ role: m.from === 'user' ? 'user' : 'assistant', content: m.text });
    });
  }
  messages.push({ role: 'user', content: contextPrefix + 'Message: ' + userMsg });
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: SYSTEM_PROMPT, messages: messages })
  });
  if (!res.ok) {
    const e = await res.json().catch(function() { return {}; });
    throw new Error((e.error && e.error.message) || ('API error ' + res.status));
  }
  const data = await res.json();
  const raw = (data.content || []).map(function(b) { return b.text || ''; }).join('').trim();
  return JSON.parse(raw);
}

const MIN_MATCH_SCORE = 5;

function findMatches(listings, buyers, dismissedMatches) {
  var matches = [];
  buyers.filter(function(b) { return b.status === 'looking'; }).forEach(function(buyer) {
    listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; }).forEach(function(listing) {
      if (!buyer.category || !listing.category || buyer.category !== listing.category) return;
      var isDismissed = dismissedMatches.some(function(d) { return d.listing_id === listing.id && d.buyer_id === buyer.id; });
      if (isDismissed) return;
      var score = 0;
      var isMixedAge = buyer.age && buyer.age.toLowerCase().includes('mixed');
      if (!isMixedAge && buyer.weightKg && listing.weightKg) {
        var diff = Math.abs(buyer.weightKg - listing.weightKg);
        if (diff <= 70) score += Math.round(3 * (1 - diff / 70));
      }
      if (!isMixedAge && buyer.age && listing.age && listing.age.toLowerCase().includes(buyer.age.toLowerCase())) score += 3;
      if (buyer.breed && listing.breed && listing.breed.toLowerCase().includes(buyer.breed.toLowerCase())) score += 2;
      if (score >= MIN_MATCH_SCORE) {
        matches.push({ buyerId: buyer.id, listingId: listing.id, score: score, buyer: buyer, listing: listing });
      }
    });
  });
  matches.sort(function(a, b) { return b.score - a.score; });
  return matches;
}

function findPotentialMatch(item, type, listings, buyers, dismissedMatches) {
  if (type === 'listing') {
    var activeBuyers = buyers.filter(function(b) { return b.status === 'looking'; });
    for (var i = 0; i < activeBuyers.length; i++) {
      var buyer = activeBuyers[i];
      if (!buyer.category || buyer.category !== item.category) continue;
      var score = 0;
      var isMixedAge = buyer.age && buyer.age.toLowerCase().includes('mixed');
      if (!isMixedAge && buyer.weightKg && item.weightKg) {
        var diff = Math.abs(buyer.weightKg - item.weightKg);
        if (diff <= 70) score += Math.round(3 * (1 - diff / 70));
      }
      if (!isMixedAge && buyer.age && item.age && item.age.toLowerCase().includes(buyer.age.toLowerCase())) score += 3;
      if (buyer.breed && item.breed && item.breed.toLowerCase().includes(buyer.breed.toLowerCase())) score += 2;
      if (score >= MIN_MATCH_SCORE) return buyer;
    }
  } else {
    var activeListings = listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; });
    for (var j = 0; j < activeListings.length; j++) {
      var listing = activeListings[j];
      if (!item.category || listing.category !== item.category) continue;
      var score2 = 0;
      var isMixedAge2 = item.age && item.age.toLowerCase().includes('mixed');
      if (!isMixedAge2 && item.weightKg && listing.weightKg) {
        var diff2 = Math.abs(item.weightKg - listing.weightKg);
        if (diff2 <= 70) score2 += Math.round(3 * (1 - diff2 / 70));
      }
      if (!isMixedAge2 && item.age && listing.age && listing.age.toLowerCase().includes(item.age.toLowerCase())) score2 += 3;
      if (item.breed && listing.breed && listing.breed.toLowerCase().includes(item.breed.toLowerCase())) score2 += 2;
      if (score2 >= MIN_MATCH_SCORE) return listing;
    }
  }
  return null;
}

function parseCSV(text) {
  var lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/"/g, ''); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var vals = lines[i].split(',').map(function(v) { return v.trim().replace(/"/g, ''); });
    if (vals.length < 3) continue;
    var row = {};
    headers.forEach(function(h, idx) { row[h] = vals[idx] || null; });
    rows.push({
      source: row['Source'] || null, sale_no: row['Sale_No'] || null,
      saleyard: row['Saleyard'] || null, sale_date: row['Sale_Date'] || null,
      class: row['Class'] || null, sub_class: row['Sub_Class'] || null,
      weight_range_kg: row['Weight_Range_kg'] || null,
      qty_sold: row['Qty_Sold'] ? parseInt(row['Qty_Sold']) : null,
      ave_price_per_kg: row['Ave_Price_per_KG_NZD'] ? parseFloat(row['Ave_Price_per_KG_NZD']) : null,
      min_price_per_kg: row['Min_Price_per_KG_NZD'] ? parseFloat(row['Min_Price_per_KG_NZD']) : null,
      max_price_per_kg: row['Max_Price_per_KG_NZD'] ? parseFloat(row['Max_Price_per_KG_NZD']) : null,
      ave_price_per_hd: row['Ave_Price_per_HD_NZD'] ? parseFloat(row['Ave_Price_per_HD_NZD']) : null,
      min_price_per_hd: row['Min_Price_per_HD_NZD'] ? parseFloat(row['Min_Price_per_HD_NZD']) : null,
      max_price_per_hd: row['Max_Price_per_HD_NZD'] ? parseFloat(row['Max_Price_per_HD_NZD']) : null,
    });
  }
  return rows;
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
    setBusy(true); setErr(null);
    try {
      if (mode === 'login') { await signIn(email.trim(), password.trim()); }
      else { await signUp(email.trim(), password.trim()); setDone(true); }
    } catch(e) { setErr(e.message || 'Something went wrong'); }
    setBusy(false);
  }

  if (done) {
    return (
      <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
          <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Check your email</div>
          <div style={{ fontSize: 14, color: '#666', marginBottom: 16, lineHeight: 1.6 }}>Confirmation link sent to <strong>{email}</strong>. Click it to verify, then wait for admin approval.</div>
          <button onClick={function() { setDone(false); setMode('login'); }} style={{ background: '#2d4a2d', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 14, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Back to Login</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 380, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🐄</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#1a2e1a', letterSpacing: 1 }}>STOCKBOSSNZ</div>
          <div style={{ fontSize: 10, color: '#a0b89a', letterSpacing: 2 }}>SMART LIVESTOCK MATCHING</div>
        </div>
        <div style={{ display: 'flex', marginBottom: 24, background: '#f5f0e8', borderRadius: 8, padding: 4 }}>
          <button onClick={function() { setMode('login'); setErr(null); }} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 13, fontWeight: 'bold', background: mode === 'login' ? '#2d4a2d' : 'transparent', color: mode === 'login' ? '#fff' : '#666' }}>Log In</button>
          <button onClick={function() { setMode('signup'); setErr(null); }} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 13, fontWeight: 'bold', background: mode === 'signup' ? '#2d4a2d' : 'transparent', color: mode === 'signup' ? '#fff' : '#666' }}>Sign Up</button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Email</div>
          <input value={email} onChange={function(e) { setEmail(e.target.value); }} onKeyDown={function(e) { if (e.key === 'Enter') handleSubmit(); }} type="email" placeholder="your@email.com" style={{ width: '100%', padding: '10px 12px', border: '2px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Password</div>
          <input value={password} onChange={function(e) { setPassword(e.target.value); }} onKeyDown={function(e) { if (e.key === 'Enter') handleSubmit(); }} type="password" placeholder="••••••••" style={{ width: '100%', padding: '10px 12px', border: '2px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
        </div>
        {err && <div style={{ background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 7, padding: '9px 13px', fontSize: 12, color: '#c00', marginBottom: 16 }}>{err}</div>}
        <button onClick={handleSubmit} disabled={busy || !email.trim() || !password.trim()} style={{ width: '100%', padding: '12px', border: 'none', borderRadius: 8, background: (busy || !email.trim() || !password.trim()) ? '#999' : '#2d4a2d', color: '#fff', cursor: (busy || !email.trim() || !password.trim()) ? 'not-allowed' : 'pointer', fontFamily: 'Georgia,serif', fontSize: 15, fontWeight: 'bold' }}>
          {busy ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Sign Up'}
        </button>
        {mode === 'signup' && <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>After signing up you will need to confirm your email and wait for admin approval.</div>}
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
        <div style={{ fontSize: 14, color: '#666', marginBottom: 24, lineHeight: 1.6 }}>Your account is pending admin approval.</div>
        <button onClick={onSignOut} style={{ background: 'none', border: '1px solid #ccc', color: '#666', borderRadius: 8, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Sign Out</button>
      </div>
    </div>
  );
}

function EditListingModal({ listing, onSave, onClose }) {
  var [breed, setBreed] = useState(listing.breed || '');
  var [age, setAge] = useState(listing.age || '');
  var [weightKg, setWeightKg] = useState(listing.weightKg || '');
  var [quantity, setQuantity] = useState(listing.quantity || '');
  var [pricePerHead, setPricePerHead] = useState(listing.pricePerHead || '');
  var [location, setLocation] = useState(listing.location || '');
  var [notes, setNotes] = useState(listing.notes || '');
  var [condition, setCondition] = useState(listing.condition || '');

  function handleSave() {
    onSave(Object.assign({}, listing, {
      breed: breed || null, age: age || null,
      weightKg: weightKg ? parseFloat(weightKg) : null,
      quantity: quantity ? parseInt(quantity) : listing.quantity,
      pricePerHead: pricePerHead ? parseFloat(pricePerHead) : null,
      location: location || null, notes: notes || null, condition: condition || null
    }));
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 16 }}>Edit Listing — {listing.seller}</div>
        {[['Breed', breed, setBreed], ['Age', age, setAge], ['Weight (kg)', weightKg, setWeightKg], ['Quantity', quantity, setQuantity], ['Price per head', pricePerHead, setPricePerHead], ['Location', location, setLocation], ['Condition', condition, setCondition], ['Notes', notes, setNotes]].map(function(f) {
          return (
            <div key={f[0]} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 3 }}>{f[0]}</div>
              <input value={f[1]} onChange={function(e) { f[2](e.target.value); }} style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontFamily: 'Georgia,serif', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
          <button onClick={handleSave} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#2d4a2d', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function EditBuyerModal({ buyer, onSave, onClose }) {
  var [breed, setBreed] = useState(buyer.breed || '');
  var [age, setAge] = useState(buyer.age || '');
  var [weightKg, setWeightKg] = useState(buyer.weightKg || '');
  var [quantity, setQuantity] = useState(buyer.quantity || '');
  var [maxPricePerHead, setMaxPricePerHead] = useState(buyer.maxPricePerHead || '');
  var [notes, setNotes] = useState(buyer.notes || '');

  function handleSave() {
    onSave(Object.assign({}, buyer, {
      breed: breed || null, age: age || null,
      weightKg: weightKg ? parseFloat(weightKg) : null,
      quantity: quantity ? parseInt(quantity) : null,
      maxPricePerHead: maxPricePerHead ? parseFloat(maxPricePerHead) : null,
      notes: notes || null
    }));
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 16 }}>Edit Buyer — {buyer.name}</div>
        {[['Breed', breed, setBreed], ['Age', age, setAge], ['Weight (kg)', weightKg, setWeightKg], ['Quantity', quantity, setQuantity], ['Max price per head', maxPricePerHead, setMaxPricePerHead], ['Notes', notes, setNotes]].map(function(f) {
          return (
            <div key={f[0]} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 3 }}>{f[0]}</div>
              <input value={f[1]} onChange={function(e) { f[2](e.target.value); }} style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontFamily: 'Georgia,serif', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
          <button onClick={handleSave} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#2d4a2d', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function InTalksPromptModal({ potentialMatch, matchType, onConfirmMatch, onDifferentPerson, onClose }) {
  var [name, setName] = useState('');
  var [phone, setPhone] = useState('');
  var [step, setStep] = useState(potentialMatch ? 'confirm' : 'manual');

  if (step === 'confirm' && potentialMatch) {
    var matchName = matchType === 'listing' ? potentialMatch.name : potentialMatch.seller;
    return (
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 380, width: '100%' }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Potential Match Found</div>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 20, lineHeight: 1.6 }}>
            There is a potential match with <strong>{matchName}</strong> — is this who you are in talks with?
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={function() { setStep('manual'); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 13 }}>No, different person</button>
            <button onClick={function() { onConfirmMatch(potentialMatch); }} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#8e44ad', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Yes!</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 380, width: '100%' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>In Talks With...</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>Who are you in talks with? (optional)</div>
        <input value={name} onChange={function(e) { setName(e.target.value); }} placeholder="Name" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }} />
        <input value={phone} onChange={function(e) { setPhone(e.target.value); }} placeholder="Phone (optional)" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 16, boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={function() { onDifferentPerson(null, null); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 13 }}>Skip</button>
          <button onClick={function() { onDifferentPerson(name || null, phone || null); }} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#8e44ad', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function WithdrawModal({ name, type, onConfirm, onClose }) {
  var [reason, setReason] = useState('');
  var [soldElsewhere, setSoldElsewhere] = useState(false);
  var [soldTo, setSoldTo] = useState('');
  var [soldPrice, setSoldPrice] = useState('');
  var [soldWhere, setSoldWhere] = useState('');

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 380, width: '100%' }}>
        <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>Withdraw — {name}</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>Why are you withdrawing this {type}?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {['Sold elsewhere', 'Pulled from market', 'Wrong listing / mistake'].map(function(r) {
            return (
              <button key={r} onClick={function() { setReason(r); setSoldElsewhere(r === 'Sold elsewhere'); }} style={{ padding: '10px', border: '2px solid ' + (reason === r ? '#2d4a2d' : '#ddd'), borderRadius: 8, background: reason === r ? '#f5f0e8' : '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 13, textAlign: 'left' }}>{r}</button>
            );
          })}
        </div>
        {soldElsewhere && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: '#555', marginBottom: 6 }}>Extra details (optional but valuable):</div>
            <input value={soldTo} onChange={function(e) { setSoldTo(e.target.value); }} placeholder="Who did they deal with?" style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontFamily: 'Georgia,serif', fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
            <input value={soldPrice} onChange={function(e) { setSoldPrice(e.target.value); }} placeholder="Price per head ($)" type="number" style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontFamily: 'Georgia,serif', fontSize: 12, marginBottom: 8, boxSizing: 'border-box' }} />
            <input value={soldWhere} onChange={function(e) { setSoldWhere(e.target.value); }} placeholder="Where? (saleyard, private, works...)" style={{ width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontFamily: 'Georgia,serif', fontSize: 12, boxSizing: 'border-box' }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
          <button onClick={function() { onConfirm({ reason, soldTo: soldTo || null, soldPrice: soldPrice ? parseFloat(soldPrice) : null, soldWhere: soldWhere || null }); }} disabled={!reason} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: !reason ? '#999' : '#e67e22', color: '#fff', cursor: !reason ? 'not-allowed' : 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Withdraw</button>
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ listings, buyers, onNotification }) {
  var [adminUnlocked, setAdminUnlocked] = useState(false);
  var [adminPass, setAdminPass] = useState('');
  var [adminErr, setAdminErr] = useState(null);
  var [csvBusy, setCsvBusy] = useState(false);
  var [csvMsg, setCsvMsg] = useState(null);
  var [clearConfirm, setClearConfirm] = useState(false);
  var fileRef = useRef(null);

  function unlockAdmin() {
    if (adminPass === ADMIN_PASSWORD) { setAdminUnlocked(true); setAdminErr(null); }
    else { setAdminErr('Incorrect password'); }
  }

  async function handleCSVUpload(e) {
    var file = e.target.files[0]; if (!file) return;
    setCsvBusy(true); setCsvMsg(null);
    try {
      var text = await file.text();
      var rows = parseCSV(text);
      if (rows.length === 0) { setCsvMsg('No valid rows found in CSV.'); setCsvBusy(false); return; }
      await saveMarketData(rows);
      setCsvMsg('Uploaded ' + rows.length + ' rows successfully!');
      onNotification('Market data uploaded — ' + rows.length + ' rows!');
    } catch(e) { setCsvMsg('Error: ' + e.message); }
    setCsvBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleClear() {
    try { await clearMarketData(); setClearConfirm(false); setCsvMsg('Market data cleared.'); onNotification('Market data cleared.'); }
    catch(e) { setCsvMsg('Error: ' + e.message); }
  }

  var sold = listings.filter(function(l) { return l.status === 'sold'; });
  var available = listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; });
  var activeBuyers = buyers.filter(function(b) { return b.status === 'looking'; });
  var totalRevenue = sold.reduce(function(sum, l) { return sum + ((l.actualSalePrice || l.pricePerHead || 0) * (l.quantitySold || l.quantity || 0)); }, 0);

  if (!adminUnlocked) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 340, margin: '40px auto', border: '1px solid #ddd' }}>
          <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>Admin Access</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>Enter admin password to continue</div>
          <input value={adminPass} onChange={function(e) { setAdminPass(e.target.value); }} onKeyDown={function(e) { if (e.key === 'Enter') unlockAdmin(); }} type="password" placeholder="Password" style={{ width: '100%', padding: '10px', border: '2px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, boxSizing: 'border-box', marginBottom: 12, outline: 'none' }} />
          {adminErr && <div style={{ color: '#c00', fontSize: 12, marginBottom: 12 }}>{adminErr}</div>}
          <button onClick={unlockAdmin} style={{ width: '100%', padding: '10px', background: '#2d4a2d', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 14, fontWeight: 'bold', cursor: 'pointer' }}>Unlock</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 10, letterSpacing: 1 }}>ADMIN PANEL</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        {[{ label: 'Active Listings', value: available.length }, { label: 'Active Buyers', value: activeBuyers.length }, { label: 'Total Sold', value: sold.length }, { label: 'Est. Revenue', value: '$' + Math.round(totalRevenue).toLocaleString() }].map(function(s) {
          return (
            <div key={s.label} style={{ background: '#fff', borderRadius: 8, padding: '12px 14px', border: '1px solid #ddd' }}>
              <div style={{ fontSize: 10, color: '#888', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 'bold', color: '#1a2e1a' }}>{s.value}</div>
            </div>
          );
        })}
      </div>
      <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #ddd', padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>Market Reference Data</div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>Upload your market data CSV to power the price estimate feature. Update fortnightly for best results.</div>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleCSVUpload} style={{ display: 'none' }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={function() { fileRef.current && fileRef.current.click(); }} disabled={csvBusy} style={{ flex: 1, padding: '10px', background: csvBusy ? '#999' : '#2d4a2d', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold', cursor: csvBusy ? 'not-allowed' : 'pointer' }}>
            {csvBusy ? 'Uploading...' : 'Upload CSV'}
          </button>
          <button onClick={function() { setClearConfirm(true); }} style={{ padding: '10px 14px', background: 'none', border: '1px solid #c0392b', color: '#c0392b', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 12, cursor: 'pointer' }}>Clear</button>
        </div>
        {csvMsg && <div style={{ marginTop: 10, fontSize: 12, color: csvMsg.startsWith('Error') ? '#c00' : '#2d6a4f', fontWeight: 'bold' }}>{csvMsg}</div>}
        {clearConfirm && (
          <div style={{ marginTop: 12, padding: 12, background: '#fff0f0', borderRadius: 8, border: '1px solid #ffcccc' }}>
            <div style={{ fontSize: 12, color: '#c00', marginBottom: 8 }}>This will delete all market reference data. Are you sure?</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={function() { setClearConfirm(false); }} style={{ flex: 1, padding: '8px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 11 }}>Cancel</button>
              <button onClick={handleClear} style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6, background: '#c0392b', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 11, fontWeight: 'bold' }}>Yes, Clear</button>
            </div>
          </div>
        )}
      </div>
      <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #ddd', padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>User Approvals</div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>To approve new users, go to Supabase and confirm their email manually.</div>
        <a href="https://supabase.com/dashboard/project/nnbmafrcosibaubzkkaf/auth/users" target="_blank" rel="noreferrer" style={{ display: 'block', padding: '10px', background: '#f5f0e8', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 12, color: '#2d4a2d', textAlign: 'center', textDecoration: 'none', fontWeight: 'bold' }}>Open Supabase Users →</a>
      </div>
      <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #ddd', padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 4 }}>More Admin Features</div>
        <div style={{ fontSize: 11, color: '#888', lineHeight: 1.5 }}>Coming soon: broadcast messages, bulk listing management, analytics dashboard.</div>
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
  var [marketData, setMarketData] = useState([]);
  var [dismissedMatches, setDismissedMatches] = useState([]);
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
  var [filterBuyerCat, setFilterBuyerCat] = useState('all');
  var [editListing, setEditListing] = useState(null);
  var [editBuyer, setEditBuyer] = useState(null);
  var [inTalksPrompt, setInTalksPrompt] = useState(null);
  var [withdrawModal, setWithdrawModal] = useState(null);
  var bottom = useRef(null);
  var fileRef = useRef(null);

  var isAdmin = session && session.user && session.user.email === ADMIN_EMAIL;

  useEffect(function() {
    getSession().then(function(s) { setSession(s); setAuthLoading(false); });
    var listener = supabase.auth.onAuthStateChange(function(event, s) { setSession(s); });
    return function() { listener.data.subscription.unsubscribe(); };
  }, []);

  useEffect(function() {
    if (!session) return;
    async function load() {
      try {
        var results = await Promise.all([getListings(), getBuyers(), getMessages(), getDismissedMatches()]);
        var ls = results[0]; var bs = results[1]; var ms = results[2]; var dm = results[3];
        var mapped = ls.map(function(l) { return { id: l.id, seller: l.seller, sellerPhone: l.seller_phone, buyer: l.buyer, buyerPhone: l.buyer_phone, breed: l.breed, category: l.category, age: l.age, weightKg: l.weight_kg, condition: l.condition, location: l.location, trucking: l.trucking, nature: l.nature, quantity: l.quantity, quantitySold: l.quantity_sold, pricePerHead: l.price_per_head, centsPerKg: l.cents_per_kg, actualSalePrice: l.actual_sale_price, notes: l.notes, photoUrl: l.photo_url, dateAdded: l.date_added, dateSold: l.date_sold, status: l.status, inTalksWith: l.in_talks_with || null, inTalksPhone: l.in_talks_phone || null }; });
        var mappedBuyers = bs.map(function(b) { return { id: b.id, name: b.name, phone: b.phone, breed: b.breed, category: b.category, age: b.age, quantity: b.quantity, weightKg: b.weight_kg || null, maxPricePerHead: b.max_price_per_head, notes: b.notes, dateAdded: b.date_added, status: b.status, inTalksWith: b.in_talks_with || null, inTalksPhone: b.in_talks_phone || null }; });
        setListings(mapped); setBuyers(mappedBuyers); setDismissedMatches(dm);
        if (ms.length > 0) { setMsgs(ms); } else {
          setMsgs([{ from: 'ai', text: "G'day! I'm StockBossNZ. To add stock or a buyer I need at least: name, age (e.g. R2, weaner), sex/class (e.g. steers, heifers), and weight. Mixed age mobs don't need a weight. Example: 'Pete has 80 Angus R2 steers 420kg Hawkes Bay $1100/hd'", extra: null }]);
        }
      } catch(e) { setErr('Could not load: ' + e.message); }
      setLoading(false);
    }
    load();
  }, [session]);

  useEffect(function() { if (bottom.current) bottom.current.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function handleSignOut() { await signOut(); setSession(null); setListings([]); setBuyers([]); setMsgs([]); setMarketData([]); setDismissedMatches([]); }
  function showNotification(text) { setNotification(text); setTimeout(function() { setNotification(null); }, 4000); }

  async function send(overrideInput) {
    var msg = (overrideInput || input).trim();
    if (!msg || busy) return;
    setInput(''); setErr(null);
    var userMsg = { from: 'user', text: msg, extra: null };
    var newMsgs = msgs.concat([userMsg]);
    setMsgs(newMsgs); await saveMessage(userMsg); setBusy(true);
    try {
      var mdToSend = [];
      if (isPriceQuery(msg)) {
        if (marketData.length === 0) {
          var freshMd = await getMarketData();
          setMarketData(freshMd);
          mdToSend = freshMd;
        } else {
          mdToSend = marketData;
        }
      }
      var result = await askClaude(msg, listings, buyers, msgs, mdToSend);
      var updatedListings = listings; var updatedBuyers = buyers;
      if (result.listings) { updatedListings = result.listings; setListings(updatedListings); await saveAllListings(updatedListings); }
      if (result.buyers) { updatedBuyers = result.buyers; setBuyers(updatedBuyers); for (var i = 0; i < updatedBuyers.length; i++) { await saveBuyer(updatedBuyers[i]); } }
      if (result.action === 'add_stock') {
        showNotification('Stock added!'); setTab('stock');
        var matches = findMatches(updatedListings, updatedBuyers, dismissedMatches);
        if (matches.length > 0) {
          var matchMsg = { from: 'ai', text: 'Heads up! Found ' + matches.length + ' potential match' + (matches.length > 1 ? 'es' : '') + ' with buyers. Check the Matches tab!', extra: null };
          newMsgs = newMsgs.concat([{ from: 'ai', text: result.message || 'Done.', extra: result.estimate || null }]);
          setMsgs(newMsgs.concat([matchMsg])); await saveMessage(matchMsg); setBusy(false); return;
        }
      }
      if (result.action === 'add_buyer') {
        showNotification('Buyer added!'); setTab('buyers');
        var matches2 = findMatches(updatedListings, updatedBuyers, dismissedMatches);
        if (matches2.length > 0) {
          var matchMsg2 = { from: 'ai', text: 'Great news! Found ' + matches2.length + ' potential match' + (matches2.length > 1 ? 'es' : '') + ' in current stock. Check the Matches tab!', extra: null };
          newMsgs = newMsgs.concat([{ from: 'ai', text: result.message || 'Done.', extra: null }]);
          setMsgs(newMsgs.concat([matchMsg2])); await saveMessage(matchMsg2); setBusy(false); return;
        }
      }
      if (result.action === 'sell_stock') setTab('sold');
      var aiMsg = { from: 'ai', text: result.message || 'Done.', extra: result.estimate || null };
      setMsgs(newMsgs.concat([aiMsg])); await saveMessage(aiMsg);
    } catch(e) {
      setErr(e.message || 'Unknown error');
      setMsgs(newMsgs.concat([{ from: 'ai', text: 'Error: ' + (e.message || 'Unknown error'), extra: null }]));
    }
    setBusy(false);
  }

  async function handlePhoto(e) {
    var file = e.target.files[0]; if (!file) return; setBusy(true);
    try { await uploadPhoto(file); showNotification('Photo uploaded!'); } catch(e) { setErr('Upload failed: ' + e.message); }
    setBusy(false);
  }

  function exportData() {
    var json = JSON.stringify({ listings: listings, buyers: buyers }, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url;
    a.download = 'stockbossnz_export_' + new Date().toISOString().split('T')[0] + '.json'; a.click();
  }

  async function handleDeleteListing(id) {
    try {
      await deleteListing(id);
      await cleanupDismissedMatches([id], []);
      setListings(listings.filter(function(l) { return l.id !== id; }));
      setDismissedMatches(dismissedMatches.filter(function(d) { return d.listing_id !== id; }));
      setConfirmDelete(null); showNotification('Listing deleted.');
    } catch(e) { setErr('Delete failed: ' + e.message); }
  }

  async function handleDeleteBuyer(id) {
    try {
      await deleteBuyer(id);
      await cleanupDismissedMatches([], [id]);
      setBuyers(buyers.filter(function(b) { return b.id !== id; }));
      setDismissedMatches(dismissedMatches.filter(function(d) { return d.buyer_id !== id; }));
      setConfirmDeleteBuyer(null); showNotification('Buyer request deleted.');
    } catch(e) { setErr('Delete failed: ' + e.message); }
  }

  async function handleDismiss(listingId, buyerId) {
    await saveDismissedMatch(listingId, buyerId);
    setDismissedMatches(dismissedMatches.concat([{ listing_id: listingId, buyer_id: buyerId }]));
  }

  async function markInTalksTogether(listing, buyer) {
    var updatedListings = listings.map(function(l) {
      return l.id === listing.id ? Object.assign({}, l, { status: 'matched', inTalksWith: buyer.name, inTalksPhone: buyer.phone || null }) : l;
    });
    var updatedBuyers = buyers.map(function(b) {
      return b.id === buyer.id ? Object.assign({}, b, { status: 'in_talks', inTalksWith: listing.seller, inTalksPhone: listing.sellerPhone || null }) : b;
    });
    setListings(updatedListings); await saveAllListings(updatedListings);
    setBuyers(updatedBuyers); for (var i = 0; i < updatedBuyers.length; i++) { if (updatedBuyers[i].id === buyer.id) await saveBuyer(updatedBuyers[i]); }
    showNotification('Moved to In Talks!'); setTab('matched');
  }

  async function markListingInTalks(listing, talksWith, talksPhone) {
    var updatedListings = listings.map(function(l) {
      return l.id === listing.id ? Object.assign({}, l, { status: 'matched', inTalksWith: talksWith || null, inTalksPhone: talksPhone || null }) : l;
    });
    setListings(updatedListings); await saveAllListings(updatedListings);
    showNotification('Moved to In Talks!'); setTab('matched');
  }

  async function markBuyerInTalks(buyer, talksWith, talksPhone) {
    var updatedBuyers = buyers.map(function(b) {
      return b.id === buyer.id ? Object.assign({}, b, { status: 'in_talks', inTalksWith: talksWith || null, inTalksPhone: talksPhone || null }) : b;
    });
    setBuyers(updatedBuyers);
    for (var i = 0; i < updatedBuyers.length; i++) { if (updatedBuyers[i].id === buyer.id) await saveBuyer(updatedBuyers[i]); }
    showNotification('Moved to In Talks!'); setTab('matched');
  }

  async function reListListing(listing) {
  var linkedBuyer = buyers.find(function(b) { return b.name === listing.inTalksWith && b.status === 'in_talks'; });
  var updatedListings = listings.map(function(l) { return l.id === listing.id ? Object.assign({}, l, { status: 'available', inTalksWith: null, inTalksPhone: null }) : l; });
  var updatedBuyers = linkedBuyer ? buyers.map(function(b) { return b.id === linkedBuyer.id ? Object.assign({}, b, { status: 'looking', inTalksWith: null, inTalksPhone: null }) : b; }) : buyers;
  setListings(updatedListings);
  setBuyers(updatedBuyers);
  await saveAllListings(updatedListings);
  if (linkedBuyer) { for (var i = 0; i < updatedBuyers.length; i++) { if (updatedBuyers[i].id === linkedBuyer.id) await saveBuyer(updatedBuyers[i]); } }
  showNotification('Re-listed!');
}

  async function reListBuyer(buyer) {
    var updatedBuyers = buyers.map(function(b) { return b.id === buyer.id ? Object.assign({}, b, { status: 'looking', inTalksWith: null, inTalksPhone: null }) : b; });
    setBuyers(updatedBuyers);
    for (var i = 0; i < updatedBuyers.length; i++) { if (updatedBuyers[i].id === buyer.id) await saveBuyer(updatedBuyers[i]); }
    showNotification('Re-listed!');
  }

  async function handleWithdraw(item, type, data) {
    var notesSuffix = data.reason === 'Sold elsewhere'
      ? 'Withdrawn - ' + (type === 'listing' ? 'sold' : 'bought') + ' elsewhere' + (data.soldTo ? ' with ' + data.soldTo : '') + (data.soldPrice ? ' at $' + data.soldPrice + '/hd' : '') + (data.soldWhere ? ' via ' + data.soldWhere : '')
      : 'Withdrawn - ' + data.reason;
    if (type === 'listing') {
      var updatedListings = listings.map(function(l) {
        return l.id === item.id ? Object.assign({}, l, { status: 'inactive', notes: (l.notes ? l.notes + ' | ' : '') + notesSuffix, actualSalePrice: data.soldPrice || l.actualSalePrice }) : l;
      });
      setListings(updatedListings); await saveAllListings(updatedListings);
      await cleanupDismissedMatches([item.id], []);
      setDismissedMatches(dismissedMatches.filter(function(d) { return d.listing_id !== item.id; }));
    } else {
      var updatedBuyers = buyers.map(function(b) {
        return b.id === item.id ? Object.assign({}, b, { status: 'inactive', notes: (b.notes ? b.notes + ' | ' : '') + notesSuffix }) : b;
      });
      setBuyers(updatedBuyers);
      for (var i = 0; i < updatedBuyers.length; i++) { if (updatedBuyers[i].id === item.id) await saveBuyer(updatedBuyers[i]); }
      await cleanupDismissedMatches([], [item.id]);
      setDismissedMatches(dismissedMatches.filter(function(d) { return d.buyer_id !== item.id; }));
    }
    setWithdrawModal(null); showNotification('Withdrawn.');
  }

  async function saveEditListing(updated) {
    var newListings = listings.map(function(l) { return l.id === updated.id ? updated : l; });
    setListings(newListings); await saveAllListings(newListings);
    setEditListing(null); showNotification('Listing updated!');
  }

  async function saveEditBuyer(updated) {
    var newBuyers = buyers.map(function(b) { return b.id === updated.id ? updated : b; });
    setBuyers(newBuyers);
    for (var i = 0; i < newBuyers.length; i++) { if (newBuyers[i].id === updated.id) await saveBuyer(newBuyers[i]); }
    setEditBuyer(null); showNotification('Buyer updated!');
  }

  async function saveSell() {
    if (!sellModal) return;
    var rem = sellModal.quantity - (sellModal.quantitySold || 0);
    var qty = sellQty ? parseInt(sellQty) : rem;
    if (isNaN(qty) || qty <= 0) qty = rem; if (qty > rem) qty = rem;
    var newSold = (sellModal.quantitySold || 0) + qty;
    var newStatus = newSold >= sellModal.quantity ? 'sold' : 'partial';
    var updatedListings = listings.map(function(l) {
      if (l.id !== sellModal.id) return l;
      return Object.assign({}, l, { quantitySold: newSold, buyer: sellBuyer || l.buyer || null, actualSalePrice: sellPrice ? parseFloat(sellPrice) : null, dateSold: new Date().toISOString(), status: newStatus });
    });
    setListings(updatedListings); await saveAllListings(updatedListings);
    await cleanupDismissedMatches([sellModal.id], []);
    setDismissedMatches(dismissedMatches.filter(function(d) { return d.listing_id !== sellModal.id; }));
    setSellModal(null); setSellQty(''); setSellBuyer(''); setSellPrice('');
    showNotification(qty + ' head marked as sold!'); setTab('sold');
  }

  if (authLoading) return <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8dcc8', fontSize: 18 }}>Loading...</div>;
  if (!session) return <AuthScreen />;
  if (!session.user.email_confirmed_at) return <PendingScreen onSignOut={handleSignOut} />;

  var available = listings.filter(function(l) { return l.status === 'available' || l.status === 'partial'; });
  var inTalksListings = listings.filter(function(l) { return l.status === 'matched'; });
  var inTalksBuyers = buyers.filter(function(b) { return b.status === 'in_talks'; });
  var sold = listings.filter(function(l) { return l.status === 'sold'; });
  var activeBuyers = buyers.filter(function(b) { return b.status === 'looking'; });
  var allMatches = findMatches(listings, buyers, dismissedMatches);
  var totalInTalks = inTalksListings.length + inTalksBuyers.filter(function(b) {
    return !inTalksListings.some(function(l) { return l.inTalksWith === b.name; });
  }).length;

  var categories = ['all'].concat([...new Set(available.map(function(l) { return l.category; }).filter(Boolean))]);
  var buyerCategories = ['all'].concat([...new Set(activeBuyers.map(function(b) { return b.category; }).filter(Boolean))]);

  var shownStock = tab === 'sold' ? sold : available;
  if (tab === 'stock' && filterCat !== 'all') shownStock = shownStock.filter(function(l) { return l.category === filterCat; });
  var shownBuyers = filterBuyerCat === 'all' ? activeBuyers : activeBuyers.filter(function(b) { return b.category === filterBuyerCat; });

  if (loading) return <div style={{ fontFamily: 'Georgia,serif', background: '#1a2e1a', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8dcc8', fontSize: 18 }}>Loading StockBossNZ...</div>;

  var tabs = [
    { k: 'chat', label: 'Chat' },
    { k: 'stock', label: 'Sellers (' + available.length + ')' },
    { k: 'buyers', label: 'Buyers (' + activeBuyers.length + ')' },
    { k: 'matches', label: 'Matches (' + allMatches.length + ')' },
    { k: 'matched', label: 'In Talks (' + totalInTalks + ')' },
    { k: 'sold', label: 'Sold (' + sold.length + ')' }
  ];
  if (isAdmin) tabs.push({ k: 'admin', label: 'Admin' });

  var btnStyle = function(bg) { return { flex: 1, padding: '10px 6px', background: bg, border: 'none', color: '#fff', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold' }; };

  return (
    <div style={{ fontFamily: 'Georgia,serif', background: '#f5f0e8', minHeight: '100vh', display: 'flex', flexDirection: 'column', maxWidth: 900, margin: '0 auto' }}>

      {notification && <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', background: '#27ae60', color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, fontWeight: 'bold', zIndex: 1000, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>{notification}</div>}

      {editListing && <EditListingModal listing={editListing} onSave={saveEditListing} onClose={function() { setEditListing(null); }} />}
      {editBuyer && <EditBuyerModal buyer={editBuyer} onSave={saveEditBuyer} onClose={function() { setEditBuyer(null); }} />}
      {inTalksPrompt && (
        <InTalksPromptModal
          potentialMatch={inTalksPrompt.potentialMatch}
          matchType={inTalksPrompt.matchType}
          onConfirmMatch={function(match) {
            if (inTalksPrompt.matchType === 'listing') {
              markInTalksTogether(inTalksPrompt.item, match);
            } else {
              markInTalksTogether(match, inTalksPrompt.item);
            }
            setInTalksPrompt(null);
          }}
          onDifferentPerson={function(name, phone) {
            if (inTalksPrompt.matchType === 'listing') {
              markListingInTalks(inTalksPrompt.item, name, phone);
            } else {
              markBuyerInTalks(inTalksPrompt.item, name, phone);
            }
            setInTalksPrompt(null);
          }}
          onClose={function() { setInTalksPrompt(null); }}
        />
      )}
      {withdrawModal && <WithdrawModal name={withdrawModal.name} type={withdrawModal.type} onConfirm={function(data) { handleWithdraw(withdrawModal.item, withdrawModal.type, data); }} onClose={function() { setWithdrawModal(null); }} />}

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
            <div style={{ fontSize: 16, fontWeight: 'bold', color: '#1a2e1a', marginBottom: 8 }}>Delete this buyer?</div>
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
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{(sellModal.seller || sellModal.name || '') + ' - ' + (sellModal.breed || '') + (sellModal.age ? ' ' + sellModal.age : '')}</div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>{'How many head sold? (blank = all ' + ((sellModal.quantity || 1) - (sellModal.quantitySold || 0)) + ' remaining)'}</div>
            <input value={sellQty} onChange={function(e) { setSellQty(e.target.value); }} type="number" placeholder={'All ' + ((sellModal.quantity || 1) - (sellModal.quantitySold || 0)) + ' head'} style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }} />
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>Buyer/Seller name and phone (optional):</div>
            <input value={sellBuyer} onChange={function(e) { setSellBuyer(e.target.value); }} placeholder="e.g. Johnson 0421 234 567" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }} />
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Actual sale price per head:</div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>{'Listed at ' + (sellModal.pricePerHead ? '$' + sellModal.pricePerHead + '/hd' : 'no price') + ' — what did it actually sell for?'}</div>
            <input value={sellPrice} onChange={function(e) { setSellPrice(e.target.value); }} type="number" placeholder={sellModal.pricePerHead ? String(sellModal.pricePerHead) : 'e.g. 950'} style={{ width: '100%', padding: '10px', border: '2px solid #2d6a4f', borderRadius: 8, fontFamily: 'Georgia,serif', fontSize: 13, marginBottom: 20, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={function() { setSellModal(null); setSellQty(''); setSellBuyer(''); setSellPrice(''); }} style={{ flex: 1, padding: '10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Cancel</button>
              <button onClick={saveSell} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#2d4a2d', color: '#fff', cursor: 'pointer', fontFamily: 'Georgia,serif', fontWeight: 'bold' }}>Mark Sold</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ position: 'relative', background: '#1a2e1a', color: '#e8dcc8', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'url(' + FARM_PHOTO_URL + ')', backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.5 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(10,30,10,0.35)' }} />
        <div style={{ position: 'relative', zIndex: 1, fontSize: 28 }}>🐄</div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 'bold', letterSpacing: 1 }}>STOCKBOSSNZ</div>
          <div style={{ fontSize: 9, color: '#a0b89a', letterSpacing: 2 }}>SMART LIVESTOCK MATCHING</div>
        </div>
        <div style={{ position: 'relative', zIndex: 1, marginLeft: 'auto', fontSize: 11, color: '#e8dcc8', textAlign: 'right' }}>
          <div>{available.length + ' lots available'}</div>
          <div>{activeBuyers.length + ' buyers looking'}</div>
          {allMatches.length > 0 && <div style={{ color: '#f0d060' }}>{allMatches.length + ' matches!'}</div>}
        </div>
        <button onClick={exportData} style={{ position: 'relative', zIndex: 1, marginLeft: 8, background: 'none', border: '1px solid #e8dcc8', color: '#e8dcc8', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Export</button>
        <button onClick={handleSignOut} style={{ position: 'relative', zIndex: 1, background: 'none', border: '1px solid #e8dcc8', color: '#e8dcc8', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Log Out</button>
      </div>

      <div style={{ display: 'flex', background: '#2d4a2d', alignItems: 'center', overflowX: 'auto', position: 'sticky', top: 0, zIndex: 100 }}>
        {tabs.map(function(t) {
          return <button key={t.k} onClick={function() { setTab(t.k); }} style={{ background: tab === t.k ? '#f5f0e8' : 'transparent', color: tab === t.k ? '#1a2e1a' : '#c8d8c0', border: 'none', padding: '10px 14px', cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, whiteSpace: 'nowrap', fontWeight: tab === t.k ? 'bold' : 'normal' }}>{t.label}</button>;
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
                    <div style={{ maxWidth: '82%', background: isUser ? '#2d4a2d' : '#ffffff', color: isUser ? '#e8dcc8' : '#222', borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px', padding: '10px 14px', fontSize: 14, lineHeight: 1.5, border: isUser ? 'none' : '1px solid #ddd', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                      {!isUser && <div style={{ fontSize: 9, color: '#aaa', marginBottom: 3, letterSpacing: 1 }}>STOCKBOSSNZ AI</div>}
                      {m.text}
                    </div>
                    {m.extra && (
                      <div style={{ maxWidth: '82%', marginTop: 6, background: '#1a2e1a', color: '#e8dcc8', borderRadius: 10, padding: '12px 16px', fontSize: 13 }}>
                        <div style={{ fontWeight: 'bold', marginBottom: 6, color: '#f0d060', fontSize: 11 }}>PRICE ESTIMATE</div>
                        <div style={{ display: 'flex', gap: 20, marginBottom: 8 }}>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: '#a0b89a' }}>LOW</div><div style={{ fontSize: 22, fontWeight: 'bold', color: '#74c69d' }}>{'$' + m.extra.low}</div></div>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: '#a0b89a' }}>MID</div><div style={{ fontSize: 22, fontWeight: 'bold', color: '#f0d060' }}>{'$' + m.extra.mid}</div></div>
                          <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: '#a0b89a' }}>HIGH</div><div style={{ fontSize: 22, fontWeight: 'bold', color: '#e8dcc8' }}>{'$' + m.extra.high}</div></div>
                        </div>
                        <div style={{ fontSize: 11, color: '#a0b89a', lineHeight: 1.4 }}>{m.extra.reasoning}</div>
                      </div>
                    )}
                  </div>
                );
              })}
              {busy && <div style={{ display: 'flex' }}><div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: '14px 14px 14px 4px', padding: '10px 14px', color: '#aaa', fontSize: 13 }}>Thinking...</div></div>}
              <div ref={bottom} />
            </div>
            {err && <div style={{ margin: '0 18px 8px', padding: '9px 13px', background: '#fff0f0', border: '1px solid #ffcccc', borderRadius: 7, fontSize: 12, color: '#c00' }}>{'Error: ' + err}</div>}
            <div style={{ padding: '0 18px 8px', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {['Pete has 80 Angus R2 steers 420kg Hawkes Bay $1100/hd', 'Johnson looking for 60 R2 steers around 400kg up to $1100', 'What would Angus R2 steers 420kg be worth?'].map(function(q) {
                return <button key={q} onClick={function() { send(q); }} style={{ background: 'none', border: '1px solid #2d4a2d', color: '#2d4a2d', borderRadius: 20, padding: '4px 11px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>{q}</button>;
              })}
              <button onClick={function() { fileRef.current && fileRef.current.click(); }} style={{ background: 'none', border: '1px solid #6d4c41', color: '#6d4c41', borderRadius: 20, padding: '4px 11px', fontSize: 11, cursor: 'pointer', fontFamily: 'Georgia,serif' }}>Upload photo</button>
              <input ref={fileRef} type="file" accept="image/*" onChange={handlePhoto} style={{ display: 'none' }} />
            </div>
            <div style={{ padding: '8px 18px 18px', display: 'flex', gap: 8 }}>
              <input value={input} onChange={function(e) { setInput(e.target.value); }} onKeyDown={function(e) { if (e.key === 'Enter') send(); }} placeholder="Add stock or buyer — include name, age, sex and weight..." style={{ flex: 1, padding: '11px 14px', borderRadius: 9, border: '2px solid #2d4a2d', fontFamily: 'Georgia,serif', fontSize: 14, background: '#fff', outline: 'none', color: '#111' }} />
              <button onClick={function() { send(); }} disabled={busy || !input.trim()} style={{ background: (busy || !input.trim()) ? '#999' : '#2d4a2d', color: '#e8dcc8', border: 'none', borderRadius: 9, padding: '11px 18px', cursor: (busy || !input.trim()) ? 'not-allowed' : 'pointer', fontFamily: 'Georgia,serif', fontSize: 14, fontWeight: 'bold' }}>Send</button>
            </div>
            <button onClick={function() { if (bottom.current) bottom.current.scrollIntoView({ behavior: 'smooth' }); }} style={{ position: 'fixed', bottom: 90, right: 20, width: 44, height: 44, borderRadius: '50%', background: '#2d4a2d', color: '#fff', border: 'none', fontSize: 20, cursor: 'pointer', zIndex: 50, boxShadow: '0 2px 8px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>↓</button>
          </div>
        )}

        {(tab === 'stock' || tab === 'sold') && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {tab === 'stock' && categories.length > 1 && (
              <div style={{ display: 'flex', gap: 7, marginBottom: 12, flexWrap: 'wrap' }}>
                {categories.map(function(c) { return <button key={c} onClick={function() { setFilterCat(c); }} style={{ background: filterCat === c ? (CAT_COLORS[c] || '#2d4a2d') : 'none', color: filterCat === c ? '#fff' : '#555', border: '1px solid ' + (CAT_COLORS[c] || '#2d4a2d'), borderRadius: 20, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'Georgia,serif', textTransform: 'capitalize' }}>{c}</button>; })}
              </div>
            )}
            {shownStock.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>
                {tab === 'sold' ? 'Nothing sold yet.' : 'No stock listed. Use Chat to add some.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {shownStock.map(function(l) {
                  var badge = getBadge(l.status);
                  var cc = CAT_COLORS[l.category] || '#78909c';
                  var rem = l.quantity - (l.quantitySold || 0);
                  var listingMatches = allMatches.filter(function(m) { return m.listingId === l.id; });
                  return (
                    <div key={l.id} style={{ background: '#fff', borderRadius: 10, border: '1px solid #ddd', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', overflow: 'hidden', opacity: l.status === 'sold' ? 0.65 : 1, borderLeft: '5px solid ' + cc }}>
                      <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'flex-start', gap: 12, position: 'relative' }}>
                        {tab === 'stock' && (
                          <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                            <button onClick={function() { setEditListing(l); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 2 }}>✏️</button>
                            <button onClick={function() { setConfirmDelete(l.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#c0392b', padding: 2, fontWeight: 'bold' }}>✕</button>
                          </div>
                        )}
                        {l.photoUrl && <img src={l.photoUrl} alt="stock" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 7, flexShrink: 0 }} />}
                        <div style={{ flex: 1, minWidth: 0, paddingRight: tab === 'stock' ? 90 : 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 15, fontWeight: 'bold', color: '#1a2e1a' }}>{l.seller}</span>
                            {l.sellerPhone && <span style={{ fontSize: 11, color: '#888' }}>{l.sellerPhone}</span>}
                            <span style={{ background: cc, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, textTransform: 'uppercase' }}>{l.category}</span>
                            {listingMatches.length > 0 && <span style={{ background: '#f0d060', color: '#1a2e1a', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 'bold' }}>{listingMatches.length + ' MATCH' + (listingMatches.length > 1 ? 'ES' : '')}</span>}
                          </div>
                          <div style={{ fontSize: 14, color: '#333', marginBottom: 3 }}><strong>{l.breed}</strong>{l.age ? (' - ' + l.age) : ''}{l.weightKg ? (' - ' + l.weightKg + 'kg') : ''}{l.condition ? (' - ' + l.condition) : ''}</div>
                          {(l.location || l.nature || l.trucking) && <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{[l.location, l.nature, l.trucking].filter(Boolean).join(' · ')}</div>}
                          <div style={{ fontSize: 12, color: '#888' }}>
                            {l.pricePerHead ? <span style={{ color: '#2d6a4f', fontWeight: 'bold' }}>{'$' + l.pricePerHead + '/hd'}{l.centsPerKg ? (' (' + l.centsPerKg + 'c/kg)') : ''}</span> : <span style={{ color: '#bbb' }}>Price TBC</span>}
                            {l.notes ? ('  |  ' + l.notes) : ''}
                          </div>
                          {l.buyer && <div style={{ fontSize: 12, color: '#6d4c41', marginTop: 3 }}>{'Buyer: ' + l.buyer + (l.buyerPhone ? ' - ' + l.buyerPhone : '')}</div>}
                          {l.actualSalePrice && <div style={{ fontSize: 12, marginTop: 3 }}><span style={{ color: '#aaa' }}>{'Listed: $' + (l.pricePerHead || 'TBC') + ' -> '}</span><span style={{ color: '#2d6a4f', fontWeight: 'bold' }}>{'Sold: $' + l.actualSalePrice + '/hd'}</span></div>}
                          {l.dateSold && <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{'Sold ' + new Date(l.dateSold).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</div>}
                        </div>
                        <div style={{ textAlign: 'center', minWidth: 44, flexShrink: 0, marginTop: 28 }}>
                          <div style={{ fontSize: 20, fontWeight: 'bold', color: '#1a2e1a', lineHeight: 1 }}>{rem}</div>
                          <div style={{ fontSize: 10, color: '#bbb' }}>{'of ' + l.quantity}</div>
                          {l.quantitySold > 0 && <div style={{ fontSize: 10, color: '#e67e22' }}>{l.quantitySold + ' sold'}</div>}
                          <div style={{ background: badge.color, color: '#fff', borderRadius: 5, padding: '3px 6px', fontSize: 9, fontWeight: 'bold', marginTop: 4 }}>{badge.label}</div>
                        </div>
                      </div>
                      {tab === 'stock' && (
                        <div style={{ display: 'flex', gap: 6, padding: '10px 14px', borderTop: '1px solid #f0ede8', background: '#faf8f4', flexWrap: 'wrap' }}>
                          {listingMatches.length > 0 && <button onClick={function() { setTab('matches'); }} style={{ flex: 1, padding: '10px 6px', background: '#f0d060', border: 'none', color: '#1a2e1a', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold' }}>VIEW MATCHES</button>}
                          <button onClick={function() {
                            var potential = findPotentialMatch(l, 'listing', listings, buyers, dismissedMatches);
                            setInTalksPrompt({ item: l, matchType: 'listing', potentialMatch: potential });
                          }} style={btnStyle('#8e44ad')}>IN TALKS</button>
                          <button onClick={function() { setSellModal(l); }} style={btnStyle('#2d6a4f')}>MARK SOLD</button>
                          <button onClick={function() { setWithdrawModal({ item: l, type: 'listing', name: l.seller }); }} style={btnStyle('#e67e22')}>WITHDRAW</button>
                        </div>
                      )}
                      {tab === 'sold' && (
                        <div style={{ display: 'flex', padding: '10px 14px', borderTop: '1px solid #f0ede8', background: '#faf8f4', justifyContent: 'flex-end' }}>
                          <button onClick={function() { setConfirmDelete(l.id); }} style={{ padding: '8px 16px', background: 'none', border: '1px solid #c0392b', color: '#c0392b', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12 }}>✕ Delete</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'buyers' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {buyerCategories.length > 1 && (
              <div style={{ display: 'flex', gap: 7, marginBottom: 12, flexWrap: 'wrap' }}>
                {buyerCategories.map(function(c) { return <button key={c} onClick={function() { setFilterBuyerCat(c); }} style={{ background: filterBuyerCat === c ? (CAT_COLORS[c] || '#2d4a2d') : 'none', color: filterBuyerCat === c ? '#fff' : '#555', border: '1px solid ' + (CAT_COLORS[c] || '#2d4a2d'), borderRadius: 20, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'Georgia,serif', textTransform: 'capitalize' }}>{c}</button>; })}
              </div>
            )}
            {shownBuyers.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>No buyers yet. Use Chat to add one.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {shownBuyers.map(function(b) {
                  var cc = CAT_COLORS[b.category] || '#78909c';
                  var buyerMatches = allMatches.filter(function(m) { return m.buyerId === b.id; });
                  return (
                    <div key={b.id} style={{ background: '#fff', borderRadius: 10, border: '1px solid #ddd', boxShadow: '0 1px 5px rgba(0,0,0,0.05)', overflow: 'hidden', borderLeft: '5px solid ' + (buyerMatches.length > 0 ? '#f0d060' : cc) }}>
                      <div style={{ padding: '13px 16px', position: 'relative' }}>
                        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                          <button onClick={function() { setEditBuyer(b); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 2 }}>✏️</button>
                          <button onClick={function() { setConfirmDeleteBuyer(b.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#c0392b', padding: 2, fontWeight: 'bold' }}>✕</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap', paddingRight: 52 }}>
                          <span style={{ fontSize: 15, fontWeight: 'bold', color: '#1a2e1a' }}>{b.name}</span>
                          {b.phone && <span style={{ fontSize: 11, color: '#888' }}>{b.phone}</span>}
                          {b.category && <span style={{ background: cc, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10, textTransform: 'uppercase' }}>{b.category}</span>}
                          {buyerMatches.length > 0 && <span style={{ background: '#f0d060', color: '#1a2e1a', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 'bold' }}>{buyerMatches.length + ' MATCH' + (buyerMatches.length > 1 ? 'ES' : '')}</span>}
                        </div>
                        <div style={{ fontSize: 14, color: '#333', marginBottom: 3 }}>{'Looking for: '}<strong>{b.breed || 'Any breed'}</strong>{b.age ? (' - ' + b.age) : ''}{b.quantity ? (' - ' + b.quantity + ' head') : ''}{b.weightKg ? (' - ' + b.weightKg + 'kg') : ''}</div>
                        {b.maxPricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f', fontWeight: 'bold' }}>{'Up to $' + b.maxPricePerHead + '/hd'}</div>}
                        {b.notes && <div style={{ fontSize: 12, color: '#888' }}>{b.notes}</div>}
                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{'Added ' + new Date(b.dateAdded).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, padding: '10px 14px', borderTop: '1px solid #f0ede8', background: '#faf8f4', flexWrap: 'wrap' }}>
                        {buyerMatches.length > 0 && <button onClick={function() { setTab('matches'); }} style={{ flex: 1, padding: '10px 6px', background: '#f0d060', border: 'none', color: '#1a2e1a', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12, fontWeight: 'bold' }}>VIEW MATCHES</button>}
                        <button onClick={function() {
                          var potential = findPotentialMatch(b, 'buyer', listings, buyers, dismissedMatches);
                          setInTalksPrompt({ item: b, matchType: 'buyer', potentialMatch: potential });
                        }} style={btnStyle('#8e44ad')}>IN TALKS</button>
                        <button onClick={function() { setSellModal(Object.assign({ seller: b.name, breed: b.breed, age: b.age, quantity: b.quantity || 1, quantitySold: 0, pricePerHead: b.maxPricePerHead }, b)); }} style={btnStyle('#2d6a4f')}>MARK SOLD</button>
                        <button onClick={function() { setWithdrawModal({ item: b, type: 'buyer', name: b.name }); }} style={btnStyle('#e67e22')}>WITHDRAW</button>
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
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>No quality matches yet. Make sure listings include name, age, sex and weight.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {allMatches.map(function(m, i) {
                  return (
                    <div key={i} style={{ background: '#fff', borderRadius: 10, border: '2px solid #f0d060', boxShadow: '0 2px 8px rgba(240,208,96,0.2)', overflow: 'hidden' }}>
                      <div style={{ background: '#f0d060', padding: '8px 16px', fontSize: 12, fontWeight: 'bold', color: '#1a2e1a' }}>{'POTENTIAL MATCH — Score: ' + m.score + '/8'}</div>
                      <div style={{ display: 'flex' }}>
                        <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid #f0ede8' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>SELLER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{m.listing.seller}</div>
                          <div style={{ fontSize: 13, color: '#333' }}><strong>{m.listing.breed}</strong>{m.listing.age ? ' ' + m.listing.age : ''}</div>
                          <div style={{ fontSize: 12, color: '#888' }}>{m.listing.quantity + ' head'}</div>
                          {m.listing.weightKg && <div style={{ fontSize: 12, color: '#888' }}>{m.listing.weightKg + 'kg'}</div>}
                          {m.listing.pricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f', fontWeight: 'bold' }}>{'$' + m.listing.pricePerHead + '/hd'}</div>}
                          {m.listing.location && <div style={{ fontSize: 11, color: '#aaa' }}>{m.listing.location}</div>}
                        </div>
                        <div style={{ flex: 1, padding: '12px 16px' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>BUYER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{m.buyer.name}</div>
                          {m.buyer.phone && <div style={{ fontSize: 12, color: '#888' }}>{m.buyer.phone}</div>}
                          <div style={{ fontSize: 12, color: '#333' }}>{'Wants: ' + (m.buyer.quantity ? m.buyer.quantity + ' head' : 'flexible')}</div>
                          {m.buyer.weightKg && <div style={{ fontSize: 12, color: '#888' }}>{'~' + m.buyer.weightKg + 'kg'}</div>}
                          {m.buyer.maxPricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f' }}>{'Up to $' + m.buyer.maxPricePerHead + '/hd'}</div>}
                        </div>
                      </div>
                      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0ede8', display: 'flex', gap: 8 }}>
                        <button onClick={function() { markInTalksTogether(m.listing, m.buyer); }} style={btnStyle('#8e44ad')}>IN TALKS</button>
                        <button onClick={function() { setSellModal(m.listing); }} style={btnStyle('#2d6a4f')}>MARK SOLD</button>
                        <button onClick={function() { handleDismiss(m.listing.id, m.buyer.id); }} style={{ flex: 1, padding: '10px 6px', background: 'none', border: '1px solid #999', color: '#999', borderRadius: 7, cursor: 'pointer', fontFamily: 'Georgia,serif', fontSize: 12 }}>DISMISS</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'matched' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {totalInTalks === 0 ? (
              <div style={{ textAlign: 'center', color: '#aaa', marginTop: 60, fontSize: 14 }}>No one in talks yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {inTalksListings.map(function(l) {
                  return (
                    <div key={l.id} style={{ background: '#fff', borderRadius: 10, border: '2px solid #8e44ad', overflow: 'hidden' }}>
                      <div style={{ background: '#8e44ad', padding: '8px 16px', fontSize: 12, fontWeight: 'bold', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>IN TALKS</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={function() { setEditListing(l); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', fontSize: 14, padding: 0 }}>✏️</button>
                          <button onClick={function() { setConfirmDelete(l.id); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', fontSize: 16, fontWeight: 'bold', padding: 0 }}>✕</button>
                        </div>
                      </div>
                      <div style={{ display: 'flex' }}>
                        <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid #f0ede8' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>SELLER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{l.seller}</div>
                          {l.sellerPhone && <div style={{ fontSize: 12, color: '#888' }}>{l.sellerPhone}</div>}
                          <div style={{ fontSize: 13, color: '#333' }}><strong>{l.breed}</strong>{l.age ? ' ' + l.age : ''}</div>
                          <div style={{ fontSize: 12, color: '#888' }}>{l.quantity + ' head'}</div>
                          {l.weightKg && <div style={{ fontSize: 12, color: '#888' }}>{l.weightKg + 'kg'}</div>}
                          {l.pricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f', fontWeight: 'bold' }}>{'$' + l.pricePerHead + '/hd'}</div>}
                          {l.location && <div style={{ fontSize: 11, color: '#aaa' }}>{l.location}</div>}
                        </div>
                        <div style={{ flex: 1, padding: '12px 16px' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>BUYER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{l.inTalksWith || l.buyer || 'External'}</div>
                          {(l.inTalksPhone || l.buyerPhone) && <div style={{ fontSize: 12, color: '#888' }}>{l.inTalksPhone || l.buyerPhone}</div>}
                        </div>
                      </div>
                      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0ede8', display: 'flex', gap: 8 }}>
                        <button onClick={function() { reListListing(l); }} style={btnStyle('#2980b9')}>RE-LIST</button>
                        <button onClick={function() { setSellModal(l); }} style={btnStyle('#2d6a4f')}>MARK SOLD</button>
                      </div>
                    </div>
                  );
                })}
                {inTalksBuyers.filter(function(b) {
                  return !inTalksListings.some(function(l) { return l.inTalksWith === b.name; });
                }).map(function(b) {
                  var cc = CAT_COLORS[b.category] || '#78909c';
                  return (
                    <div key={b.id} style={{ background: '#fff', borderRadius: 10, border: '2px solid #8e44ad', overflow: 'hidden' }}>
                      <div style={{ background: '#8e44ad', padding: '8px 16px', fontSize: 12, fontWeight: 'bold', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>IN TALKS</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={function() { setEditBuyer(b); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', fontSize: 14, padding: 0 }}>✏️</button>
                          <button onClick={function() { setConfirmDeleteBuyer(b.id); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', fontSize: 16, fontWeight: 'bold', padding: 0 }}>✕</button>
                        </div>
                      </div>
                      <div style={{ display: 'flex' }}>
                        <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid #f0ede8' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>SELLER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{b.inTalksWith || 'External'}</div>
                          {b.inTalksPhone && <div style={{ fontSize: 12, color: '#888' }}>{b.inTalksPhone}</div>}
                        </div>
                        <div style={{ flex: 1, padding: '12px 16px' }}>
                          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4, letterSpacing: 1 }}>BUYER</div>
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1a2e1a' }}>{b.name}</div>
                          {b.phone && <div style={{ fontSize: 12, color: '#888' }}>{b.phone}</div>}
                          <div style={{ fontSize: 13, color: '#333' }}><strong>{b.breed || 'Any breed'}</strong>{b.age ? ' ' + b.age : ''}</div>
                          {b.weightKg && <div style={{ fontSize: 12, color: '#888' }}>{b.weightKg + 'kg'}</div>}
                          {b.maxPricePerHead && <div style={{ fontSize: 12, color: '#2d6a4f' }}>{'Up to $' + b.maxPricePerHead + '/hd'}</div>}
                        </div>
                      </div>
                      <div style={{ padding: '10px 16px', borderTop: '1px solid #f0ede8', display: 'flex', gap: 8 }}>
                        <button onClick={function() { reListBuyer(b); }} style={btnStyle('#2980b9')}>RE-LIST</button>
                        <button onClick={function() { setSellModal(Object.assign({ seller: b.name, breed: b.breed, age: b.age, quantity: b.quantity || 1, quantitySold: 0, pricePerHead: b.maxPricePerHead }, b)); }} style={btnStyle('#2d6a4f')}>MARK SOLD</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'admin' && isAdmin && <AdminPanel listings={listings} buyers={buyers} onNotification={showNotification} />}

      </div>
    </div>
  );
}
