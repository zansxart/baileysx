# baileysx

Pustaka Node.js berbasis TypeScript berkinerja tinggi untuk berinteraksi dengan API WhatsApp Web secara langsung menggunakan **WebSocket** tanpa Selenium atau Chromium (hemat RAM). 

Ini merupakan **custom fork** (versi `1.0.0`) dari WhiskeySockets Baileys versi `7.0.0-rc13` yang dioptimalkan oleh **zansxart** untuk membawa kembali fitur-fitur penting yang telah dihapus di versi resmi serta meningkatkan performa dekripsi pesan.

---

## 🚀 Fitur Unggulan Custom Fork (baileysx)

Dibandingkan dengan versi resmi Baileys, **baileysx** hadir dengan peningkatan berikut:

1. **Native Buttons & List Messages (Retrofitting)**:
   - Dukungan penuh untuk membuat dan mengirim pesan Tombol (Buttons), Seksi Daftar (List), Template, Native Flow (Interactive), dan Shop langsung melalui fungsi `sendMessage`.
   - Menginjeksikan struktur XML `<biz>` secara otomatis di tingkat protokol.

2. **Solusi "Menunggu Pesan Ini" (LID-to-PN Mapping)**:
   - Pemetaan hubungan nomor telepon (PN) dan ID WhatsApp internal (LID) secara dinamis dalam memori.
   - Mengatasi delay/kegagalan dekripsi pesan privat pada chat 1-on-1 dengan meresolusi identifikasi perangkat secara tepat.

3. **Placeholder Resend Super Cepat**:
   - Memangkas delay permintaan muat ulang pesan placeholder yang belum terdekripsi dari **2000 ms menjadi 100 ms**.
   - Batas waktu deteksi offline telepon dikurangi dari **8 detik menjadi 5 detik** untuk pemrosesan pesan masuk yang lebih responsif.

4. **Dukungan Cerita Grup (Group Status / Stories)**:
   - Mengirim status media/teks langsung ke segmen cerita grup dengan membungkusnya dalam protokol `groupStatusMessageV2`.

5. **Notifikasi Token Privasi (`tcToken`)**:
   - Memancarkan event `chats.update` yang membawa data token privasi terbaru segera setelah diterima dari jaringan WhatsApp.

6. **Bypass Pesan Sekali Lihat (Anti-ViewOnce) Opsional**:
   - Secara otomatis membongkar pembungkus pesan sekali lihat (`viewOnceMessage`, `viewOnceMessageV2`, dan `viewOnceMessageV2Extension`) langsung di layer soket dan merubahnya menjadi media biasa.
   - Fitur ini dinonaktifkan secara bawaan demi kompatibilitas mundur. Cukup aktifkan dengan menambahkan properti `bypassViewOnce: true` saat inisialisasi soket.

7. **Group Mention All (Tag Semua Anggota Grup)**:
   - Tambahkan `mentionAll: true` pada opsi/konten pengiriman pesan (`sendMessage`) di grup untuk secara otomatis men-tag seluruh peserta grup tanpa harus mendefinisikan array JID manual.

8. **Auto-Read Messages (Centang Biru Otomatis)**:
   - Fitur opsional untuk mengirim status laporan dibaca (`read`) secara otomatis sesaat setelah pesan masuk diterima. Cukup aktifkan dengan menambahkan properti `autoReadMessages: true` saat inisialisasi soket.

9. **Native Event `polls.vote`**:
   - Memproses dekripsi jajak pendapat secara native langsung di dalam layer soket. Memancarkan event `'polls.vote'` dengan data lengkap: `pollId`, `voter`, `vote` terdekripsi, dan `timestamp`.

---

## 📦 Cara Instalasi

Karena ini adalah custom fork, Anda dapat menginstalnya langsung dari repositori GitHub:

### Menggunakan npm:
```bash
npm install github:zansxart/baileysx
```

### Menggunakan yarn:
```bash
yarn add github:zansxart/baileysx
```

---

## 🛠️ Panduan Memulai Cepat

Berikut adalah contoh dasar untuk menghubungkan akun WhatsApp Anda menggunakan autentikasi multi-file dan memantau pesan masuk:

```typescript
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from 'baileysx'
import { Boom } from '@hapi/boom'

async function hubungkanKeWhatsApp() {
    // 1. Mengelola sesi autentikasi (menyimpan sesi dalam folder 'sesi_baileysx')
    const { state, saveCreds } = await useMultiFileAuthState('sesi_baileysx')
    
    // 2. Inisialisasi soket WhatsApp
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // Menampilkan QR Code di terminal
    })

    // 3. Memantau pembaruan koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        
        if (connection === 'close') {
            const harusKonekUlang = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Koneksi terputus karena:', lastDisconnect?.error, '. Mencoba konek ulang:', harusKonekUlang)
            if (harusKonekUlang) {
                hubungkanKeWhatsApp()
            }
        } else if (connection === 'open') {
            console.log('Koneksi WhatsApp berhasil dibuka!')
        }
    })

    // 4. Memantau pesan masuk baru
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    console.log(`Pesan baru dari ${msg.key.remoteJid}:`, msg.message)
                    
                    // Contoh membalas pesan otomatis
                    await sock.sendMessage(msg.key.remoteJid!, { text: 'Halo! Pesan Anda telah diterima oleh baileysx.' })
                }
            }
        }
    })

    // 5. Menyimpan kredensial sesi saat ada pembaruan
    sock.ev.on('creds.update', saveCreds)
}

hubungkanKeWhatsApp()
```

---

## ✉️ Panduan Mengirim Pesan Kustom

### 1. Mengirim Pesan Tombol (Native Buttons)
```typescript
await sock.sendMessage(jid, {
    text: "Pilih opsi di bawah ini:",
    footer: "Branding zansxart",
    buttons: [
        { buttonId: 'id1', buttonText: { displayText: 'Tombol 1' } },
        { buttonId: 'id2', buttonText: { displayText: 'Tombol 2' } }
    ]
})
```

### 2. Mengirim Pesan Daftar (List Message)
```typescript
await sock.sendMessage(jid, {
    title: "Menu Utama",
    text: "Pilih layanan kami:",
    footer: "Dipersembahkan oleh zansxart",
    buttonText: "Buka Daftar",
    sections: [
        {
            title: "Kategori Produk",
            rows: [
                { title: "Produk A", rowId: "prod_a", description: "Deskripsi Produk A" },
                { title: "Produk B", rowId: "prod_b", description: "Deskripsi Produk B" }
            ]
        }
    ]
})
```

### 3. Mengirim Cerita Grup (Group Status)
```typescript
await sock.sendMessage(jid, {
    groupStatusMessage: {
        image: { url: './gambar_cerita.jpg' },
        caption: 'Cerita grup harian kami!'
    }
})
```

---

## ⚙️ Panduan Fitur Tambahan baileysx

### 1. Group Mention All (Tag Semua Anggota Grup)
Anda dapat secara otomatis men-tag seluruh anggota grup dengan menyematkan parameter `mentionAll: true` baik di opsi pesan maupun konten pesan:
```typescript
// Melalui opsi pesan (Options)
await sock.sendMessage(groupJid, { text: "Halo semuanya!" }, { mentionAll: true })

// Atau langsung dalam konten pesan
await sock.sendMessage(groupJid, { text: "Pengumuman penting!", mentionAll: true })
```

### 2. Auto-Read Messages (Centang Biru Otomatis)
Aktifkan centang biru otomatis untuk semua pesan masuk (kecuali pesan dari diri sendiri atau pesan bertipe peer) saat menginisialisasi koneksi soket:
```typescript
const sock = makeWASocket({
    auth: state,
    autoReadMessages: true // Aktifkan centang biru otomatis
})
```

### 3. Native Event `polls.vote` (Dekripsi Polling)
Dapatkan notifikasi real-time saat pengguna memilih/memilih di polling:
```typescript
sock.ev.on('polls.vote', (voteUpdate) => {
    console.log('Ada suara masuk pada polling!')
    console.log('ID Polling:', voteUpdate.pollId)
    console.log('Pemilih:', voteUpdate.voter)
    console.log('Pilihan terdekripsi:', voteUpdate.vote)
    console.log('Waktu memilih:', voteUpdate.timestamp)
})
```

---

## ⚖️ Lisensi & Disclaimer

- Pustaka ini dilisensikan di bawah lisensi **MIT**.
- Proyek ini **tidak berafiliasi, disponsori, atau disetujui secara resmi oleh WhatsApp Inc.** atau Facebook/Meta. Gunakan secara bijak dan bertanggung jawab untuk menghindari pemblokiran nomor oleh WhatsApp.
