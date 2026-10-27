import { fileTypeFromBuffer } from 'file-type';
import { fromBuffer } from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES } from '../shared/contracts.js';
import { HttpError } from './errors.js';

const invalid = () => new HttpError(415, 'Use a valid PDF, DOCX, XLSX, PPTX, PNG, JPG, WEBP or GIF file. Macro-enabled and executable files are not allowed.');
export function safeFilename(value: string): string {
  const name = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[. ]+|[. ]+$/g, '');
  if (!name) return 'document';
  if (name.length <= 180) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const stem = name.slice(0, 180 - extension.length).replace(/[\ud800-\udbff]$/, '');
  return stem + extension;
}
const officeMain = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};
const contentType = z.object({ '@_ContentType': z.string(), '@_PartName': z.string().optional() });
const manifestSchema = z.object({ Types: z.object({
  Override: z.array(contentType).default([]),
  Default: z.array(contentType).default([]),
}) });
function validManifest(xml: string, extension: keyof typeof officeMain, mainPath: string): boolean {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return false;
  try {
    const value: unknown = new XMLParser({
      ignoreAttributes: false, processEntities: false, removeNSPrefix: true,
      isArray: (name) => name === 'Override' || name === 'Default',
    }).parse(xml);
    const manifest = manifestSchema.safeParse(value);
    if (!manifest.success) return false;
    const { Override: overrides, Default: defaults } = manifest.data.Types;
    return overrides.some((part) => part['@_PartName'] === `/${mainPath}` && part['@_ContentType'] === officeMain[extension])
      && ![...overrides, ...defaults].some((part) => /macroEnabled|vbaProject|activeX|oleObject|msdownload/i.test(part['@_ContentType']));
  } catch { return false; }
}

async function validateOffice(bytes: Buffer, extension: keyof typeof officeMain) {
  await new Promise<void>((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(invalid()); return; }
      let count = 0, total = 0, contentTypes = false, main = false, settled = false;
      const fail = () => { if (!settled) { settled = true; zip.close(); reject(invalid()); } };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!contentTypes || !main) { fail(); return; }
        settled = true; zip.close(); resolve();
      });
      zip.on('entry', (entry) => {
        if (settled) return;
        count++; total += entry.uncompressedSize;
        const name: string = entry.fileName;
        if (count > 2048 || total > 100 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1)
          || /(?:^|\/)(?:vbaProject|activeX|embeddings)(?:[./]|$)/i.test(name)
          || /\.(?:exe|dll|com|bat|cmd|ps1|js|vbs|msi|scr)$/i.test(name)
          || (/\.bin$/i.test(name) && !/^(?:word|xl|ppt)\/printerSettings\/printerSettings\d+\.bin$/.test(name))) { fail(); return; }
        const required = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension];
        if (name === required) main = true;
        if (name !== '[Content_Types].xml') { zip.readEntry(); return; }
        if (contentTypes || entry.uncompressedSize > 65536) { fail(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const chunks: Buffer[] = []; let length = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 65536) { stream.destroy(); fail(); } else chunks.push(chunk);
          });
          stream.on('end', () => {
            if (settled) return;
            const xml = Buffer.concat(chunks).toString('utf8');
            if (!validManifest(xml, extension, required)) { fail(); return; }
            contentTypes = true; zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
export async function validateDocument(bytes: Buffer, originalName: string) {
  if (!bytes.length || bytes.length > DOCUMENT_MAX_BYTES) throw new HttpError(413, 'Documents must be non-empty and at most 10 MB.');
  const filename = safeFilename(originalName);
  const extension = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : '';
  if (!Object.hasOwn(DOCUMENT_TYPES, extension)) throw invalid();
  const mimeType = DOCUMENT_TYPES[extension as keyof typeof DOCUMENT_TYPES];
  if (Object.hasOwn(officeMain, extension)) {
    await validateOffice(bytes, extension as keyof typeof officeMain);
  } else {
    let detected;
    try { detected = await fileTypeFromBuffer(bytes); } catch { throw invalid(); }
    if (detected?.mime !== mimeType) throw invalid();
  }
  return { filename, mimeType };
}
