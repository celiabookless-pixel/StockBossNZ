import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nnbmafrcosibaubzkkaf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uYm1hZnJjb3NpYmF1Ynpra2FmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MzYwMDksImV4cCI6MjA5MTUxMjAwOX0.Ylq7h70iHcz_lF87Xu9clNAbkICe7iFQ1_zZSo2YJRo';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getListings() {
  const { data, error } = await supabase.from('listings').select('*').order('date_added', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveListing(listing) {
  const row = {
    id: listing.id, seller: listing.seller || null, seller_phone: listing.sellerPhone || null,
    buyer: listing.buyer || null, buyer_phone: listing.buyerPhone || null,
    breed: listing.breed || null, category: listing.category || null, age: listing.age || null,
    weight_kg: listing.weightKg || null, condition: listing.condition || null,
    location: listing.location || null, trucking: listing.trucking || null, nature: listing.nature || null,
    quantity: listing.quantity || 0, quantity_sold: listing.quantitySold || 0,
    price_per_head: listing.pricePerHead || null, cents_per_kg: listing.centsPerKg || null,
    actual_sale_price: listing.actualSalePrice || null, notes: listing.notes || null,
    photo_url: listing.photoUrl || null, date_added: listing.dateAdded || new Date().toISOString(),
    date_sold: listing.dateSold || null, status: listing.status || 'available'
  };
  const { error } = await supabase.from('listings').upsert(row);
  if (error) throw error;
}

export async function saveAllListings(listings) {
  for (const l of listings) { await saveListing(l); }
}

export async function deleteListing(id) {
  const { error } = await supabase.from('listings').delete().eq('id', id);
  if (error) throw error;
}

export async function uploadPhoto(file) {
  const ext = file.name.split('.').pop();
  const fileName = Date.now() + '.' + ext;
  const { error } = await supabase.storage.from('photos').upload(fileName, file);
  if (error) throw error;
  const { data } = supabase.storage.from('photos').getPublicUrl(fileName);
  return data.publicUrl;
}

export async function getMessages() {
  const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: true }).limit(100);
  if (error) throw error;
  return (data || []).map(function(m) { return { from: m.from_role, text: m.message, extra: m.extra }; });
}

export async function saveMessage(msg) {
  const { error } = await supabase.from('messages').insert({ from_role: msg.from, message: msg.text, extra: msg.extra || null });
  if (error) throw error;
}

export async function getBuyers() {
  const { data, error } = await supabase.from('buyers').select('*').order('date_added', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveBuyer(buyer) {
  const row = {
    id: buyer.id, name: buyer.name || null, phone: buyer.phone || null,
    breed: buyer.breed || null, category: buyer.category || null, age: buyer.age || null,
    quantity: buyer.quantity || null, weight_kg: buyer.weightKg || null,
    max_price_per_head: buyer.maxPricePerHead || null, notes: buyer.notes || null,
    date_added: buyer.dateAdded || new Date().toISOString(), status: buyer.status || 'looking'
  };
  const { error } = await supabase.from('buyers').upsert(row);
  if (error) throw error;
}

export async function deleteBuyer(id) {
  const { error } = await supabase.from('buyers').delete().eq('id', id);
  if (error) throw error;
}

export async function saveMarketData(rows) {
  const { error } = await supabase.from('market_data').insert(rows);
  if (error) throw error;
}

export async function getMarketData() {
  const { data, error } = await supabase.from('market_data').select('*').order('sale_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function clearMarketData() {
  const { error } = await supabase.from('market_data').delete().neq('id', 0);
  if (error) throw error;
}
