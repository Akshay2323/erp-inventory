const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const exportRoot = path.join(root, 'export');
const folderName = `inventory-app-${pkg.version}`;
const outDir = path.join(exportRoot, folderName);

const COPY_ITEMS = [
  'src',
  'scripts',
  'package.json',
  'package-lock.json',
  'README.md',
  'INVENTORY_APP_EXPLAIN.txt',
  '.env.example',
];

const DEPLOY_TEXT = `inventory-app export v${pkg.version}
================================

1) Copy this folder to server
2) cp .env.example .env   (edit DB + JWT + ENCRYPTION_KEY)
3) npm install --omit=dev
4) npm run build          (safe — live data preserved)
5) npm start

API:     http://localhost:4000
Swagger: http://localhost:4000/api-docs
Login:   admin / admin123  (only if no users exist yet)
`;

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyItem(name) {
  const src = path.join(root, name);
  const dest = path.join(outDir, name);
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main() {
  console.log(`Exporting ${folderName}...`);

  rmDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of COPY_ITEMS) copyItem(item);
  fs.writeFileSync(path.join(outDir, 'DEPLOY.txt'), DEPLOY_TEXT, 'utf8');

  const zipPath = path.join(exportRoot, `${folderName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  fs.mkdirSync(exportRoot, { recursive: true });

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${outDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`cd "${exportRoot}" && zip -r "${folderName}.zip" "${folderName}"`, { stdio: 'inherit' });
  }

  console.log('');
  console.log('Export ready:');
  console.log(`  Folder: ${outDir}`);
  console.log(`  Zip:    ${zipPath}`);
}

main();
