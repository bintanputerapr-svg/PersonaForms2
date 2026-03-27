# PersonaForms Research

Website kuisioner berbahasa Indonesia untuk peneliti dengan gaya visual lembut terinspirasi 16Personalities dan alur kerja seperti Google Forms.

## Fitur utama

- Peneliti dapat login ke portal builder.
- Password lokal awal peneliti: `niswahjelek`.
- Mendukung banyak kuisioner dalam satu portal.
- Tipe item:
  - pernyataan / teks informasi
  - jawaban singkat
  - jawaban paragraf
  - pilihan ganda
  - pilihan ganda + lainnya
  - kotak centang
  - skala linier setuju - tidak setuju
- Kuisioner dapat dibagikan lewat link publik berbasis slug, misalnya `?form=survei-kepuasan`.
- Jawaban responden tersimpan ke database Supabase.
- Peneliti dapat mengekspor respons ke CSV agar rapi dibuka di spreadsheet.

## File penting

- `index.html` : tampilan website
- `styles.css` : gaya visual
- `script.js` : logika builder, responden, ekspor, dan Supabase
- `supabase-schema.sql` : skema database
- `supabase-config.js` : konfigurasi URL dan anon key Supabase

## Menjalankan lokal

1. Buka `index.html` langsung di browser.
2. Untuk masuk portal peneliti secara lokal, gunakan password `niswahjelek`.
3. Tanpa Supabase, data disimpan di browser masing-masing.

## Menjalankan online

1. Buat project Supabase.
2. Jalankan isi `supabase-schema.sql`.
3. Buat akun peneliti di Supabase Auth. Jika ingin sesuai kebutuhan awal, gunakan password `niswahjelek`.
4. Isi `supabase-config.js`.
5. Deploy folder project ini ke Netlify atau Vercel.

## Catatan

- Jika ingin responden umum mengisi dari internet, Supabase wajib aktif.
- `anonKey` aman dipakai di frontend, tetapi `service role key` tidak boleh dimasukkan ke project ini.
