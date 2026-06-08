# Donate System · k.praewa

ระบบรับโดเนทพร้อม Alert + เสียงอ่าน (TTS) สำหรับ streamer
ใช้กับธนาคารกสิกร เลขบัญชี **166-8-15077-9** ชื่อ **แพรวา คล้ำมีศรี**

## คุณสมบัติ

- 💸 หน้า donor สำหรับผู้โดเนท พร้อมแสดง QR PromptPay + เลขบัญชี
- ⚙️ หน้า Widget Settings ปรับแต่งสี / ฟอนต์ / เอฟเฟ็กต์ / ข้อความ / เสียง
- 📺 หน้า Overlay สำหรับเสียบใน OBS Browser Source (พื้นหลังโปร่งใส)
- 🔔 Alert เด้งขึ้นพร้อมเสียงเอฟเฟ็กต์
- 🗣 TTS อ่านชื่อ + ข้อความผ่าน Google Translate TTS (ฟรี ไม่ต้องใช้ API key)
- ⚡ Realtime ผ่าน Socket.IO — กดส่งปุ๊บ Alert ขึ้น OBS ปั๊บ
- 📜 บันทึกประวัติ donation

---

## วิธีติดตั้งและรัน

### 1) ติดตั้ง Node.js
ดาวน์โหลด Node.js **v20 ขึ้นไป** จาก https://nodejs.org

### 2) ติดตั้ง dependencies
เปิด PowerShell ในโฟลเดอร์นี้แล้วรัน:
```powershell
npm install
```

### 3) สตาร์ทเซิร์ฟเวอร์
```powershell
npm start
```

จะเห็นข้อความ:
```
  Donor page : http://localhost:3000/
  Widget     : http://localhost:3000/widget
  Overlay    : http://localhost:3000/overlay   (← ใส่ใน OBS Browser Source)
```

### 4) ตั้งค่าครั้งแรก
1. เปิด http://localhost:3000/widget ในเบราเซอร์
2. ใส่ **PromptPay ID** (เบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก ที่ผูกกับบัญชีกสิกร)
3. ปรับสี/ฟอนต์/เอฟเฟ็กต์ตามต้องการ — บันทึกอัตโนมัติ
4. กด **▶ ทดสอบ Alert** เพื่อดูตัวอย่าง

### 5) ใส่ Overlay ใน OBS
1. ใน OBS → Sources → **+** → **Browser**
2. ตั้งค่า:
   - **URL**: `http://localhost:3000/overlay`
   - **Width**: 1920 / **Height**: 1080
   - ติ๊ก ✅ **Control audio via OBS** (เพื่อให้ OBS อัดเสียง TTS เข้า stream)
3. กด OK เสร็จ

---

## ลิงก์สำหรับแชร์ผู้ชม

- ลิงก์โดเนท: `http://localhost:3000/`
- ถ้าจะให้ผู้ชมโดเนทจากที่อื่นได้ ต้องใช้ tunnel เช่น `ngrok http 3000` แล้วใช้ URL ที่ ngrok สร้างให้

---

## โครงสร้างไฟล์

```
server.js              เซิร์ฟเวอร์ Express + Socket.IO + PromptPay QR + TTS proxy
package.json           dependencies
data/
  settings.json        การตั้งค่า (แก้ผ่าน /widget ได้)
  donations.json       ประวัติ donation
public/
  index.html           หน้า donor
  widget.html          หน้าตั้งค่า
  overlay.html         หน้า OBS (โปร่งใส)
  assets/
    style.css          shared styles
    coin.mp3           (วางไฟล์เสียง notification ของคุณที่นี่)
```

> **หมายเหตุเสียง notification**: ระบบไม่ได้แถม mp3 มา — ให้วางไฟล์ของคุณใน `public/assets/`
> เช่น `public/assets/coin.mp3` แล้วใส่ path `/assets/coin.mp3` ใน widget settings
> ถ้ายังไม่ตั้ง ระบบจะข้ามเสียงเอฟเฟ็กต์ (ยังอ่าน TTS ปกติ)

---

## ตัวแปรในเทมเพลต

ใช้ในช่อง "ข้อความหัวเรื่อง" และ "เทมเพลตเสียง":

| ตัวแปร       | ความหมาย                 |
|-------------|--------------------------|
| `{name}`    | ชื่อผู้โดเนท              |
| `{amount}`  | จำนวนเงิน                |
| `{message}` | ข้อความ (เฉพาะใน TTS)    |

ตัวอย่าง:
- Title: `{name} โดเนท {amount} บาท ขอบคุณค่า!`
- TTS: `คุณ {name} โดเนทมา {amount} บาท บอกว่า {message}`

---

## การ deploy/แชร์ออกอินเตอร์เน็ต

ถ้าอยากให้คนอื่นเข้ามาโดเนทจากนอกบ้านได้:

**วิธีง่ายสุด (ngrok)**:
```powershell
# ติดตั้ง ngrok จาก https://ngrok.com แล้ว
ngrok http 3000
```
จะได้ URL เช่น `https://abcd1234.ngrok.io` เอาไปแปะ stream ได้เลย

**Overlay ใน OBS ยังคงใช้ localhost** (เร็วกว่า ไม่ต้องผ่านอินเตอร์เน็ต)

---

## ข้อจำกัด

- TTS ผ่าน Google Translate รองรับ ~200 ตัวอักษร/ครั้ง (ถ้าข้อความยาวกว่านี้ระบบตัดให้)
- ไม่ได้เชื่อม API ธนาคาร — ใช้ระบบ "ซื่อสัตย์" (donor กดเองหลังโอน)
- เก็บข้อมูลในไฟล์ JSON local — ไม่เหมาะกับโดเนทจำนวนมหาศาล
