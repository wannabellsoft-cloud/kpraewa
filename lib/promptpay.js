// PromptPay EMVCo payload generation + QR decoding helpers
function tlv(id, value) {
  const v = String(value);
  return id + v.length.toString().padStart(2, '0') + v;
}

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function promptpayPayload(rawId, amount) {
  const id = String(rawId || '').replace(/\D/g, '');
  if (!id) return null;
  let proxyValue, proxyType;
  if (id.length === 13) {
    proxyType = '02';
    proxyValue = id;
  } else if (id.length === 10) {
    proxyType = '01';
    proxyValue = '0066' + id.substring(1);
  } else if (id.length === 15) {
    proxyType = '03';
    proxyValue = id;
  } else {
    proxyType = '01';
    proxyValue = id;
  }
  const merchant = tlv('00', 'A000000677010111') + tlv(proxyType, proxyValue);
  let payload =
    tlv('00', '01') +
    tlv('01', amount ? '12' : '11') +
    tlv('29', merchant) +
    tlv('53', '764');
  if (amount && Number(amount) > 0) {
    payload += tlv('54', Number(amount).toFixed(2));
  }
  payload += tlv('58', 'TH');
  payload += '6304';
  return payload + crc16(payload);
}

function parseTLV(payload) {
  const out = {};
  let i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) break;
    const tag = payload.substring(i, i + 2);
    const len = parseInt(payload.substring(i + 2, i + 4), 10);
    if (Number.isNaN(len) || i + 4 + len > payload.length) break;
    const value = payload.substring(i + 4, i + 4 + len);
    out[tag] = value;
    i += 4 + len;
  }
  return out;
}

function parsePromptPayQR(payload) {
  const root = parseTLV(payload);
  const merchant = root['29'] ? parseTLV(root['29']) : {};
  const aid = merchant['00'] || '';
  let proxyType = null, proxyValue = null, proxyLabel = null;
  if (merchant['01']) { proxyType = '01'; proxyValue = merchant['01']; proxyLabel = 'Mobile'; }
  else if (merchant['02']) { proxyType = '02'; proxyValue = merchant['02']; proxyLabel = 'National ID'; }
  else if (merchant['03']) { proxyType = '03'; proxyValue = merchant['03']; proxyLabel = 'e-Wallet ID'; }
  else if (merchant['04']) { proxyType = '04'; proxyValue = merchant['04']; proxyLabel = 'Bank Account'; }

  let inputForm = proxyValue;
  if (proxyType === '01' && proxyValue && proxyValue.startsWith('0066')) {
    inputForm = '0' + proxyValue.substring(4);
  }
  return {
    aid,
    proxyType,
    proxyValue,
    proxyLabel,
    inputForm,
    amount: root['54'] ? Number(root['54']) : null,
    countryCode: root['58'] || null,
    currencyCode: root['53'] || null,
    merchantName: root['59'] || null,
    isPromptPay: aid === 'A000000677010111',
    isTrueMoney: proxyType === '03' && proxyValue && proxyValue.startsWith('0040')
  };
}

module.exports = { promptpayPayload, parsePromptPayQR };
