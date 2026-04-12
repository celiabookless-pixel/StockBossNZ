import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nnbmafrcosibaubzkkaf.supabase.co';
const SUPABASE_KEY = 'Sb_publishable_SS7DAjDZWr9risVwto4GPw_D_-T9DQh';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function getListings() {
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .order('date_added', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveListing(listing) {
  const row = {
    id: listing.id,
    seller: listing.seller || null,
    seller_phone: listing.sellerPhone || null,
    buyer: listing.buyer || null,
    buyer_phone: listing.buyerPhone || null,
    breed: listing.breed || null,
    category: listing.category || null,
    age: listing.age || null,
    weight_kg: listing.weightKg || null,
    condition: listing.condition || null,
    location: listing.location || null,
    trucking: listing.trucking || null,
    nature: listing.nature || null,
    quantity: listing.quantity || 0,
    quantity_sold: listing.quantitySold || 0,
    price_per_head: listing.pricePerHead || null,
    cents_per_kg: listing.centsPerKg || null,
    notes: listing.notes || null,
    photo_url: listing.photoUrl || null,
    date_added: listing.dateAdded || new Date().toISOString(),
    date_sold: listing.dateSold || null,
    status: listing.status || 'available'
  };
  const { error } = await supabase.from('listings').upsert(row);
  if (error) throw error;
}

export async function saveAllListings(listings) {
  for (const l of listings) {
    await saveListing(l);
  }
}

export async function uploadPhoto(file) {
  const ext = file.name.split('.').pop();
  const fileName = Date.now() + '.' + ext;
  const { error } = await supabase.storage
    .from('photos')
    .upload(fileName, file);
  if (error) throw error;
  const { data } = supabase.storage.from('photos').getPublicUrl(fileName);
  return data.publicUrl;
}

export async function getMessages() {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data || []).map(function(m) {
    return { from: m.from_role, text: m.message, extra: m.extra };
  });
}

export async function saveMessage(msg) {
  const { error } = await supabase.from('messages').insert({
    from_role: msg.from,
    message: msg.text,
    extra: msg.extra || null
  });
  if (error) throw error;
}
