import { crc32 } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./config.js', () => ({ config: { LOG_LEVEL: 'silent' } }));
import { DOCUMENT_MAX_BYTES } from '../shared/contracts.js';
import { safeFilename, validateDocument } from './documentValidation.js';

function zip(entries: Record<string, string | Buffer>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(value);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const office = {
  docx: ['word/document.xml', 'wordprocessingml.document'],
  xlsx: ['xl/workbook.xml', 'spreadsheetml.sheet'],
  pptx: ['ppt/presentation.xml', 'presentationml.presentation'],
};
describe('document byte validation', () => {
  it('verifies PDF signatures without changing bytes', async () => {
    const bytes = Buffer.from('%PDF-1.7\noriginal document bytes\n%%EOF');
    const original = Buffer.from(bytes);
    expect(await validateDocument(bytes, 'Letter.PDF')).toEqual({ filename: 'Letter.PDF', mimeType: 'application/pdf' });
    expect(bytes.equals(original)).toBe(true);
  });
  it.each([
    ['png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='],
    ['gif', 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='],
    ['webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
  ])('accepts verified %s image bytes without altering them', async (extension, base64) => {
    const bytes = Buffer.from(base64, 'base64'), original = Buffer.from(bytes);
    expect((await validateDocument(bytes, `file.${extension}`)).mimeType).toBe(`image/${extension}`);
    expect(bytes).toEqual(original);
  });
  it.each(['png', 'jpg', 'webp', 'gif', 'pdf'])('rejects executable bytes renamed to %s', async (ext) => {
    await expect(validateDocument(Buffer.from('MZnot-a-document'), `file.${ext}`)).rejects.toMatchObject({ status: 415 });
  });
  it.each(['exe', 'docm', 'xlsm', 'pptm', 'svg', 'html', '__proto__'])('rejects the %s extension', async (ext) => {
    await expect(validateDocument(Buffer.from('%PDF-1.7'), `file.${ext}`)).rejects.toMatchObject({ status: 415 });
  });
  it('rejects empty and oversized files', async () => {
    await expect(validateDocument(Buffer.alloc(0), 'file.pdf')).rejects.toMatchObject({ status: 413 });
    await expect(validateDocument(Buffer.alloc(DOCUMENT_MAX_BYTES + 1), 'file.pdf')).rejects.toMatchObject({ status: 413 });
  });
  it('accepts the exact size boundary', async () => {
    const bytes = Buffer.alloc(DOCUMENT_MAX_BYTES); bytes.write('%PDF-1.7');
    expect((await validateDocument(bytes, 'file.pdf')).mimeType).toBe('application/pdf');
  });
  it.each(Object.entries(office))('validates %s package contents', async (extension, [path, type]) => {
    const bytes = zip({
      '[Content_Types].xml': `<Types><Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`,
      [path]: '<document/>',
    });
    expect((await validateDocument(bytes, `file.${extension}`)).filename).toBe(`file.${extension}`);
    await expect(validateDocument(bytes, extension === 'docx' ? 'file.xlsx' : 'file.docx')).rejects.toMatchObject({ status: 415 });
  });
  it('rejects macros and ordinary ZIPs renamed to Office documents', async () => {
    await expect(validateDocument(zip({ 'other.txt': 'text' }), 'file.docx')).rejects.toMatchObject({ status: 415 });
    await expect(validateDocument(zip({
      '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>', 'word/vbaProject.bin': 'macro',
    }), 'file.docx')).rejects.toMatchObject({ status: 415 });
    await expect(validateDocument(Buffer.from('PKtruncated'), 'file.docx')).rejects.toMatchObject({ status: 415 });
  });
  it('parses real XML attributes rather than trusting manifest strings or comments', async () => {
    const main = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
    expect((await validateDocument(zip({
      '[Content_Types].xml': `<Types><Override PartName='/word/document.xml' ContentType = '${main}' /></Types>`,
      'word/document.xml': '<document/>',
    }), 'file.docx')).filename).toBe('file.docx');
    await expect(validateDocument(zip({
      '[Content_Types].xml': `<Types><!-- ContentType="${main}" --></Types>`, 'word/document.xml': '<document/>',
    }), 'file.docx')).rejects.toMatchObject({ status: 415 });
    await expect(validateDocument(zip({
      '[Content_Types].xml': `<!DOCTYPE Types [<!ENTITY bad "value">]><Types><Override PartName="/word/document.xml" ContentType="${main}"/></Types>`,
      'word/document.xml': '<document/>',
    }), 'file.docx')).rejects.toMatchObject({ status: 415 });
  });
  it('caps Office manifests and entry counts', async () => {
    await expect(validateDocument(zip({ '[Content_Types].xml': 'x'.repeat(65537) }), 'file.docx')).rejects.toMatchObject({ status: 415 });
    const entries = Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [`file${i}.xml`, '']));
    await expect(validateDocument(zip(entries), 'file.docx')).rejects.toMatchObject({ status: 415 });
  });
  it('removes path, header injection and bidi controls from stored filenames', () => {
    expect(safeFilename('../bad\\name\r\n\u202e.pdf')).toBe('_bad_name__.pdf');
    expect(safeFilename('   ...')).toBe('document');
    expect(safeFilename('x'.repeat(200))).toHaveLength(180);
    expect(safeFilename(`${'😀'.repeat(200)}.pdf`)).toMatch(/\.pdf$/);
    expect(safeFilename(`${'😀'.repeat(200)}.pdf`).length).toBeLessThanOrEqual(180);
  });
});
