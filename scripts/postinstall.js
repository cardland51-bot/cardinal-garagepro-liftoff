import fs from 'fs';
const dataDir = process.env.DATA_DIR || './data';
const dirs = [
  `${dataDir}`,
  `${dataDir}/uploads`,
  `${dataDir}/devices`,
  `${dataDir}/payments`,
  `${dataDir}/logs`
];
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) });
console.log('[postinstall] Ensured data directories:', dirs.join(', '));
