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

10. **Rich Response & Pesan Interaktif HTML / Mini Games (Meta AI)**:
    - Dukungan pembuatan dan pengiriman pesan interaktif berbasis HTML/CSS/JavaScript (Game seperti Tebak Gambar, Tic-Tac-Toe, Slot Machine, Tetris, Catur, Ludo, dll.) langsung di dalam chat WhatsApp.
    - Mendukung format praktis via `sendMessage` (`{ html: '...' }`) maupun manual relay menggunakan `botForwardedMessage` + `richResponseMessage` (`FOAHtmlPrimitiveDemoDONOTUSE`).

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

### 4. Mengirim Pesan Interaktif HTML / Mini Games (Meta AI Rich Response)

**baileysx** mendukung pengiriman aplikasi web ringan / game interaktif berbasis HTML5, CSS, dan JavaScript yang dapat dibuka dan dimainkan secara langsung di dalam aplikasi WhatsApp menggunakan arsitektur **Meta AI Rich Response** (`richResponseMessage`).

#### ⚡ Cara 1: Menggunakan `sock.sendMessage` (Paling Praktis)
Anda dapat langsung menyematkan string HTML ke properti `html` di dalam `sendMessage`:

```typescript
const htmlGame = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
  body {
    background: #111b21;
    color: #e9edef;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    text-align: center;
    padding: 24px 16px;
    touch-action: manipulation;
  }
  .card {
    background: #1f2c34;
    border: 1px solid #2a3942;
    border-radius: 14px;
    padding: 20px;
    max-width: 320px;
    margin: 0 auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  h2 { color: #ffd166; margin-bottom: 8px; font-size: 18px; }
  p { color: #8696a0; font-size: 13px; margin-bottom: 16px; }
  .counter { font-size: 36px; font-weight: bold; color: #00a884; margin-bottom: 16px; }
  button {
    background: #00a884;
    color: #0b141a;
    border: none;
    border-radius: 10px;
    padding: 12px 24px;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    transition: transform 0.1s ease;
  }
  button:active { transform: scale(0.95); }
</style>
</head>
<body>
  <div class="card">
    <h2>🕹️ Mini Clicker</h2>
    <p>Ketuk tombol secepat mungkin!</p>
    <div class="counter" id="count">0</div>
    <button onclick="document.getElementById('count').innerText = ++count">TAP SAYA!</button>
  </div>
  <script>let count = 0;</script>
</body>
</html>`

// Kirim langsung via sendMessage:
await sock.sendMessage(jid, {
    html: htmlGame
})
```

#### 🛠️ Cara 2: Menggunakan `generateWAMessageFromContent` + `relayMessage` (Low-Level / Plugin Bot)
Jika bot Anda membutuhkan kontrol penuh atas format relay dan ID pesan:

```typescript
import { generateWAMessageFromContent } from 'baileysx'
import crypto from 'crypto'

const slots = {
    botForwardedMessage: {
        message: {
            richResponseMessage: {
                messageType: 1,
                unifiedResponse: {
                    data: Buffer.from(JSON.stringify({
                        __typename: "GenAIUnifiedResponse",
                        response_id: crypto.randomUUID(),
                        sections: [{
                            __typename: "GenAIUnifiedResponseSection",
                            view_model: {
                                __typename: "GenAISingleLayoutViewModel",
                                primitive: {
                                    __typename: "FOAHtmlPrimitiveDemoDONOTUSE", // Bypass typename client WhatsApp
                                    trusted_sources: [],
                                    payload: htmlGame
                                }
                            }
                        }]
                    })).toString("base64")
                },
                contextInfo: {
                    isForwarded: true,
                    forwardOrigin: 4
                }
            }
        }
    }
}

const msg = generateWAMessageFromContent(jid, slots, {})
await sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id
})
```

> **💡 Tips Optimalisasi HTML Game WhatsApp:**
> 1. **Meta Viewport:** Wajib gunakan `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">` agar pas di layar handphone dan tidak ter-zoom otomatis saat diklik.
> 2. **Touch Response:** Gunakan `touch-action: manipulation;` di CSS pada elemen interaktif untuk menghilangkan delay ~300ms saat disentuh di layar sentuh.
> 3. **Palet Warna WhatsApp Dark:**
>    - Background Utama: `#0b141a` atau `transparent`
>    - Container Kartu: `#111b21` atau `#1f2c34`
>    - Border: `#2a3942` atau `#374248`
>    - Aksen Hijau WhatsApp: `#00a884`
>    - Aksen Emas/Poin: `#ffd166`
>    - Teks Utama: `#e9edef`, Teks Sekunder: `#8696a0`

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
