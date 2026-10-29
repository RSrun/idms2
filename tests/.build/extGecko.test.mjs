// tests/extGecko.test.ts
import assert from "node:assert/strict";
import {
  existsSync as existsSync2,
  mkdtempSync,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync3,
  rmSync as rmSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";

// src/main/extGecko.ts
import {
  existsSync,
  mkdirSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname, isAbsolute, join as join2, normalize, resolve } from "path";

// src/main/zip.ts
import { deflateRawSync } from "zlib";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, sep } from "path";
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function dosDateTime(date) {
  const time = (date.getHours() & 31) << 11 | (date.getMinutes() & 63) << 5 | (Math.floor(date.getSeconds() / 2) & 31) << 0;
  const day = (date.getFullYear() - 1980 & 127) << 9 | (date.getMonth() + 1 & 15) << 5 | date.getDate() & 31;
  return { time: time & 65535, date: day & 65535 };
}
function collectFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}
function writeZip(srcDir, outFile) {
  const files = collectFiles(srcDir).sort();
  if (files.length === 0) throw new Error(`ZIP kayna\u011F\u0131 bo\u015F: ${srcDir}`);
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(/* @__PURE__ */ new Date());
  for (const rel of files) {
    const abs = join(srcDir, rel);
    const name = rel.split(sep).join("/");
    const nameBuf = Buffer.from(name, "utf8");
    const data = readFileSync(abs);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(67324752, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(33639248, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(2048, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(101010256, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, eocd]));
}

// src/main/extGecko.ts
var GECKO_ADDON_ID = "idms2@idms2.app";
var GECKO_XPI = `${GECKO_ADDON_ID}.xpi`;
var SIGN_PREF = "xpinstall.signatures.required";
var USER_JS_MARKER = "// IDMS: yerel eklenti (imza denetimi ve sideload kilidi kapali)";
var IS_WIN = process.platform === "win32";
function samePath(a, b) {
  const norm = (p) => normalize(resolve(p)).replace(/[\\/]+$/, "");
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
function pathsEqual(a, b) {
  return samePath(a, b);
}
var INSTALL_PREFS = [
  `user_pref("${SIGN_PREF}", false);`,
  'user_pref("extensions.autoDisableScopes", 0);'
];
var INSTALL_PREF_RES = INSTALL_PREFS.map(
  (line) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
);
function ensureInstallPrefs(profileDir) {
  const file = join2(profileDir, "user.js");
  const existing = existsSync(file) ? readFileSync2(file, "utf8") : "";
  const missing = INSTALL_PREFS.filter((line) => !existing.includes(line));
  if (missing.length === 0) return;
  let next;
  if (!existing.includes(USER_JS_MARKER)) {
    const block = `${USER_JS_MARKER}
${missing.join("\n")}
`;
    next = existing && !existing.endsWith("\n") ? `${existing}
${block}` : existing + block;
  } else {
    const lines = existing.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === USER_JS_MARKER);
    lines.splice(at + 1, 0, ...missing);
    next = lines.join("\n");
  }
  writeFileSync2(file, next, "utf8");
}
function removeInstallPrefs(profileDir) {
  const file = join2(profileDir, "user.js");
  if (!existsSync(file)) return;
  const text = readFileSync2(file, "utf8");
  if (!text.includes(USER_JS_MARKER)) return;
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === USER_JS_MARKER) {
      while (i + 1 < lines.length && INSTALL_PREF_RES.some((re) => re.test(lines[i + 1].trim()))) {
        i++;
      }
      continue;
    }
    kept.push(lines[i]);
  }
  const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (rest) writeFileSync2(file, `${rest}
`, "utf8");
  else rmSync(file, { force: true });
}
function readAddonId(extDir2) {
  try {
    const manifest = JSON.parse(readFileSync2(join2(extDir2, "manifest.json"), "utf8"));
    return manifest?.browser_specific_settings?.gecko?.id ?? null;
  } catch {
    return null;
  }
}
function installGeckoExtension(profileDir, extDir2) {
  if (!existsSync(join2(profileDir, "prefs.js")) && !existsSync(join2(profileDir, "times.json"))) {
    throw new Error("Profil klas\xF6r\xFC ge\xE7erli g\xF6r\xFCnm\xFCyor");
  }
  if (readAddonId(extDir2) !== GECKO_ADDON_ID) {
    throw new Error("Eklenti kayna\u011F\u0131 bulunamad\u0131 (gecko hedefi eksik)");
  }
  const extensionsDir = join2(profileDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  rmSync(join2(extensionsDir, GECKO_ADDON_ID), { recursive: true, force: true });
  const xpi = join2(extensionsDir, GECKO_XPI);
  const temp = join2(extensionsDir, `${GECKO_ADDON_ID}.tmp.zip`);
  try {
    writeZip(extDir2, temp);
    rmSync(xpi, { force: true });
    renameSync(temp, xpi);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new Error(
      `Eklenti yaz\u0131lamad\u0131 (taray\u0131c\u0131 a\xE7\u0131ksa kapat\u0131n): ${err.message}`
    );
  }
  ensureInstallPrefs(profileDir);
}
function uninstallGeckoExtension(profileDir) {
  const extensionsDir = join2(profileDir, "extensions");
  rmSync(join2(extensionsDir, GECKO_XPI), { force: true });
  rmSync(join2(extensionsDir, GECKO_ADDON_ID), { recursive: true, force: true });
  removeInstallPrefs(profileDir);
}

// tests/extGecko.test.ts
var extDir = join3(process.cwd(), "extension", "gecko");
var root = mkdtempSync(join3(tmpdir(), "idms-gecko-"));
function makeProfile(name) {
  const dir = join3(root, name);
  mkdirSync2(join3(dir, "extensions"), { recursive: true });
  writeFileSync3(join3(dir, "times.json"), "{}");
  writeFileSync3(join3(dir, "prefs.js"), "// prefs\n");
  return dir;
}
try {
  const profile = makeProfile("profile-a");
  installGeckoExtension(profile, extDir);
  const xpi = join3(profile, "extensions", `${GECKO_ADDON_ID}.xpi`);
  assert.ok(existsSync2(xpi), "XPI yaz\u0131lmal\u0131");
  const head = readFileSync3(xpi).subarray(0, 4);
  assert.deepEqual([...head], [80, 75, 3, 4], "XPI ge\xE7erli bir ZIP olmal\u0131");
  assert.ok(readFileSync3(xpi).length > 5e3, "XPI eklenti dosyalar\u0131n\u0131 i\xE7ermeli");
  const userJs = join3(profile, "user.js");
  const text = readFileSync3(userJs, "utf8");
  assert.match(text, /xpinstall\.signatures\.required", false/, "imza denetimi kapanmal\u0131");
  assert.match(text, /extensions\.autoDisableScopes", 0/, "sideload kilidi kapanmal\u0131");
  assert.match(text, /IDMS: yerel eklenti/, "eklenen blok i\u015Faretlenmeli");
  installGeckoExtension(profile, extDir);
  const updated = readFileSync3(userJs, "utf8");
  const prefCount = updated.split("xpinstall.signatures.required").length - 1;
  const autoCount = updated.split("extensions.autoDisableScopes").length - 1;
  assert.equal(prefCount, 1, "imza prefi bir kez yaz\u0131lmal\u0131");
  assert.equal(autoCount, 1, "sideload prefi bir kez yaz\u0131lmal\u0131");
  uninstallGeckoExtension(profile);
  assert.ok(!existsSync2(xpi), "XPI silinmeli");
  assert.ok(!existsSync2(userJs), "yaln\u0131zca bizim sat\u0131rlar\u0131m\u0131z varsa user.js silinmeli");
  const profile2 = makeProfile("profile-b");
  const own = 'user_pref("browser.tabs.warnOnClose", false);\n';
  writeFileSync3(join3(profile2, "user.js"), own);
  installGeckoExtension(profile2, extDir);
  assert.ok(readFileSync3(join3(profile2, "user.js"), "utf8").includes(own.trim()));
  uninstallGeckoExtension(profile2);
  const rest = readFileSync3(join3(profile2, "user.js"), "utf8");
  assert.equal(rest.trim(), own.trim(), "kullan\u0131c\u0131 sat\u0131r\u0131 kalmal\u0131");
  assert.ok(!rest.includes("xpinstall.signatures.required"), "bizim pref kald\u0131r\u0131lmal\u0131");
  assert.throws(
    () => installGeckoExtension(join3(root, "yok"), extDir),
    /Profil klasörü/,
    "ge\xE7ersiz profil hata vermeli"
  );
  const empty = join3(root, "empty-ext");
  mkdirSync2(empty, { recursive: true });
  writeFileSync3(join3(empty, "manifest.json"), JSON.stringify({ name: "x" }));
  assert.throws(
    () => installGeckoExtension(makeProfile("profile-c"), empty),
    /Eklenti kaynağı/,
    "gecko kimli\u011Fi olmayan kaynak reddedilmeli"
  );
  if (process.platform === "win32") {
    assert.ok(pathsEqual("C:\\A\\b", "c:\\a\\B"), "yollar harf duyars\u0131z e\u015Fle\u015Fmeli");
  }
  assert.ok(pathsEqual(join3(root, "x"), join3(root, "x")), "ayn\u0131 yollar e\u015Fle\u015Fmeli");
  console.log("\u2713 extGecko: XPI paketleme, imza ayar\u0131, kald\u0131rma ve do\u011Frulamalar ge\xE7ti");
} finally {
  rmSync2(root, { recursive: true, force: true });
}
