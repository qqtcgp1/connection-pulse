import { writeFileSync } from 'fs';

// Create a simple 32x32 ICO file with a network-like icon (blue square)
// ICO header: 6 bytes (0,0 = reserved, 1,0 = type ICO, 1,0 = image count)
// Directory entry: 16 bytes per image
// BMP image data follows

// We'll create a minimal valid ICO with a 32x32 blue square
function createIco() {
  const width = 32;
  const height = 32;
  const bpp = 24; // bits per pixel

  // BMP header size
  const bmpInfoHeaderSize = 40;
  const rowSize = Math.ceil((width * 3) / 4) * 4; // padded to 4-byte boundary
  const imageSize = rowSize * height * 2; // *2 for AND mask

  // ICO header (6 bytes)
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);     // Reserved
  icoHeader.writeUInt16LE(1, 2);     // Type: 1 = ICO
  icoHeader.writeUInt16LE(1, 4);     // Number of images

  // Directory entry (16 bytes)
  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(width, 0);           // Width
  dirEntry.writeUInt8(height, 1);          // Height
  dirEntry.writeUInt8(0, 2);               // Color palette
  dirEntry.writeUInt8(0, 3);               // Reserved
  dirEntry.writeUInt16LE(1, 4);            // Color planes
  dirEntry.writeUInt16LE(bpp, 6);          // Bits per pixel
  dirEntry.writeUInt32LE(bmpInfoHeaderSize + imageSize, 8);  // Size of image data
  dirEntry.writeUInt32LE(6 + 16, 12);      // Offset to image data

  // BMP info header (40 bytes)
  const bmpHeader = Buffer.alloc(40);
  bmpHeader.writeUInt32LE(40, 0);          // Header size
  bmpHeader.writeInt32LE(width, 4);        // Width
  bmpHeader.writeInt32LE(height * 2, 8);   // Height (x2 for ICO)
  bmpHeader.writeUInt16LE(1, 12);          // Planes
  bmpHeader.writeUInt16LE(bpp, 14);        // Bits per pixel
  bmpHeader.writeUInt32LE(0, 16);          // Compression
  bmpHeader.writeUInt32LE(imageSize, 20);  // Image size
  bmpHeader.writeInt32LE(0, 24);           // X pixels per meter
  bmpHeader.writeInt32LE(0, 28);           // Y pixels per meter
  bmpHeader.writeUInt32LE(0, 32);          // Colors used
  bmpHeader.writeUInt32LE(0, 36);          // Important colors

  // Create pixel data (BGR format, bottom-up)
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + x * 3;
      // Create a gradient blue network-like icon
      const centerX = width / 2;
      const centerY = height / 2;
      const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);

      if (dist < 12) {
        // Inner circle - light blue
        pixels[offset] = 0xEB;     // B
        pixels[offset + 1] = 0x63; // G
        pixels[offset + 2] = 0x25; // R (blue #2563EB)
      } else if (dist < 14) {
        // Border - white
        pixels[offset] = 0xFF;     // B
        pixels[offset + 1] = 0xFF; // G
        pixels[offset + 2] = 0xFF; // R
      } else {
        // Outer - dark background
        pixels[offset] = 0x0F;     // B
        pixels[offset + 1] = 0x0F; // G
        pixels[offset + 2] = 0x0F; // R
      }
    }
  }

  // AND mask (transparency mask) - all visible
  const andMask = Buffer.alloc(rowSize * height, 0);

  // Combine all parts
  const ico = Buffer.concat([icoHeader, dirEntry, bmpHeader, pixels, andMask]);

  return ico;
}

const ico = createIco();
writeFileSync('src-tauri/icons/icon.ico', ico);
console.log('Created icon.ico');

// Also create a simple PNG (just write minimal valid PNG)
// For PNG, we'll create a simple one
function createPng() {
  // Create a 32x32 blue circle PNG (very minimal)
  const width = 32;
  const height = 32;

  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);   // Bit depth
  ihdrData.writeUInt8(2, 9);   // Color type (RGB)
  ihdrData.writeUInt8(0, 10);  // Compression
  ihdrData.writeUInt8(0, 11);  // Filter
  ihdrData.writeUInt8(0, 12);  // Interlace

  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = Buffer.alloc(12 + 13);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdrData.copy(ihdr, 8);
  ihdr.writeUInt32BE(ihdrCrc, 8 + 13);

  // Create raw image data
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // Filter byte
    for (let x = 0; x < width; x++) {
      const centerX = width / 2;
      const centerY = height / 2;
      const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);

      if (dist < 12) {
        raw.push(0x25, 0x63, 0xEB); // RGB blue
      } else if (dist < 14) {
        raw.push(0xFF, 0xFF, 0xFF); // white
      } else {
        raw.push(0x0F, 0x0F, 0x0F); // dark
      }
    }
  }

  // For simplicity, we'll just write uncompressed data with zlib
  // This requires proper zlib compression, which is complex
  // Let's skip PNG for now and just use ICO

  return null;
}

// Simple CRC32 for PNG chunks
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

console.log('Done');
