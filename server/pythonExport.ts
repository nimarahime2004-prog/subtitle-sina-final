import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const PYTHON_APP_DIR = path.resolve(process.cwd(), 'python_app');

function addDirToZip(zip: JSZip, dirPath: string, baseRel: string): void {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.db')) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDirToZip(zip, fullPath, relPath);
    } else if (entry.isFile()) {
      zip.file(relPath, fs.readFileSync(fullPath));
    }
  }
}

export async function buildPythonDesktopZipBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  addDirToZip(zip, PYTHON_APP_DIR, 'AI_Subtitle_Translator_Python');
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export function listPythonDesktopFiles(): Array<{ path: string; sizeBytes: number }> {
  const files: Array<{ path: string; sizeBytes: number }> = [];
  function walk(dir: string, rel: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const full = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, r);
      } else if (entry.isFile()) {
        files.push({ path: r, sizeBytes: fs.statSync(full).size });
      }
    }
  }
  walk(PYTHON_APP_DIR, '');
  return files;
}
