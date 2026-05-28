// auth-guard.js — taruh di root repo, panggil dari semua halaman soal

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL  = 'https://uincqpdexdenjcmwdfsv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpbmNxcGRleGRlbmpjbXdkZnN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MjM4ODEsImV4cCI6MjA5NTQ5OTg4MX0.Lf1N_P_iiNQ2hnRJhd-Quy9MLKlZFSzbnXtXCnmRCS0';


const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);
const { data: { session } } = await supabase.auth.getSession();

const depth = location.pathname.split('/').filter(Boolean).length;
const base  = '../'.repeat(Math.max(depth - 2, 1)); // sesuaikan path relatif

if (!session) {
  window.location.replace(base + 'auth.html');
} else {
  const { data: usr } = await supabase
    .from('users').select('status').eq('id', session.user.id).single();

  if (!usr || usr.status !== 'active') {
    await supabase.auth.signOut();
    window.location.replace(base + 'auth.html');
  }
}