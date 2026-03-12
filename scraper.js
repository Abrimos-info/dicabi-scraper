#!/usr/bin/env node

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const URL = 'https://dicabienlinea.minfin.gob.gt/dicabi_enlinea/ConsultaEdoMat.aspx';
const TIMEOUT = 60000;

/**
 * Clean unicode RTL/invisible markers and trim whitespace.
 */
function clean(s) {
  return s.replace(/[\u200e\u200f\u200b\u200c\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ').trim();
}

function parseNumber(s) {
  const cleaned = s.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

const COLUMN_HEADERS = [
  'FECHA', 'DECLAR', 'ORD', 'NOMBRE O', 'NOMBRE', 'DIRECCION',
  'No. REGISTRO:', 'No. REGISTRO', 'REGISTRO:', 'REGISTRO',
  'FINCA', 'FOLIO', 'LIBRO', 'DE.', 'EXTENSION',
  'EN MTS 2.', 'EN MTS 2', 'EN MTS',
  'VALOR FINCA', 'QUETZALES', 'PROCEDENCIA',
  'VALOR', 'TERRENO', 'CONSTRUCCION',
  'AREA MTS 2', 'AREA MTS', 'CULTIVOS',
  'OPERAC', 'No.',
];

function isColumnHeader(line) {
  return COLUMN_HEADERS.some(h => line === h || line === h + ':');
}

function isDate(line) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(line);
}

function isDashes(line) {
  return /^-{3,}$/.test(line);
}

/**
 * Parse the Crystal Reports text output into structured data.
 */
function parseReport(rawText, queriedNit) {
  // Clean and filter empty lines
  const allLines = rawText.split('\n').map(clean);
  const lines = allLines.filter(l => l.length > 0);

  const result = {
    name: null,
    dpi: null,
    registeredOwner: null,
    registeredOwnerNit: null,
    note: null,
    matriculas: [],
    totalExtensionMts2: null,
    totalValueQuetzales: null,
  };

  // Check for co-owner note
  const noteLine = lines.find(l => l.startsWith('NOTA:'));
  if (noteLine) {
    result.note = noteLine.replace(/^NOTA:\s*/, '');
  }

  // Find registered owner (DUEÑO in the report)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^DUE.O:$/)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j] !== 'NIT:' && lines[j].match(/[A-Z]{2,}/) && !isDashes(lines[j])) {
          result.registeredOwner = lines[j];
          break;
        }
      }
      break;
    }
  }

  // Find registered owner NIT
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'NIT:') {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].match(/^\d+[-]\d+$/) || lines[j].match(/^\d+[-][A-Z]$/)) {
          result.registeredOwnerNit = lines[j];
          break;
        }
      }
      break;
    }
  }

  // Find DPI
  for (const line of lines) {
    if (line.match(/^\d{4}\s+\d{5}\s+\d{4}$/)) {
      result.dpi = line;
      break;
    }
  }

  // Resolve the queried person's name after co-owners are parsed (deferred below)

  // Find all date line indices (DD/MM/YYYY)
  const dateIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (isDate(lines[i])) dateIndices.push(i);
  }

  // Dates come in pairs: [fechaDeclar, fechaOperac]
  // Between each pair is "extension" (a number)
  // Format: fechaDeclar, extension, fechaOperac, finca, folio, libro,
  //         valorFinca, de, procedencia, ordinal, valorTerreno,
  //         valorConstruccion, areaConstruccion, valorCultivos
  // Before the first date of each property is the address block

  // Group dates into pairs
  const datePairs = [];
  for (let i = 0; i < dateIndices.length - 1; i++) {
    const idx1 = dateIndices[i];
    const idx2 = dateIndices[i + 1];
    // fechaDeclar and fechaOperac are separated by exactly one number (extension)
    if (idx2 - idx1 === 2) {
      datePairs.push({ fechaDeclIdx: idx1, fechaOperIdx: idx2 });
      i++; // skip the second date
    }
  }

  // Find MATRICULA sections
  const matriculaSections = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'MATRICULA:' && i + 1 < lines.length) {
      const id = lines[i + 1];
      if (id.match(/^\d{2}[A-Z]\d+$/)) {
        // Find end of section
        let end = lines.length;
        for (let j = i + 2; j < lines.length; j++) {
          if (lines[j].startsWith('TOTAL MATRICULA') || lines[j] === 'MATRICULA:') {
            end = j;
            break;
          }
        }
        matriculaSections.push({ id, startIdx: i + 2, endIdx: end });
      }
    }
  }

  // For each matricula, find properties using date pairs
  for (const section of matriculaSections) {
    const matricula = { id: section.id, properties: [], coOwners: [] };

    // Parse co-owners: scan for NIT/name pairs in the section
    // These appear after CONDUEÑOS: label, but also as continuations after page breaks
    function parseCoOwnerBlock(startIdx, endIdx) {
      let k = startIdx;
      while (k < endIdx) {
        const line = lines[k];
        // A NIT-like value followed by a name on the next line
        if (line.match(/^\d+[-]\d+$/) || line.match(/^\d+[-][A-Z]$/)) {
          const coOwnerNit = line;
          if (k + 1 < endIdx && lines[k + 1].match(/[A-Z]{2,}/)) {
            if (!matricula.coOwners.some(e => e.nit === coOwnerNit)) {
              matricula.coOwners.push({ nit: coOwnerNit, name: lines[k + 1] });
            }
            k += 2;
            continue;
          }
        }
        // Skip labels like "NIT :", "-", "DPI:", "CONDUEÑOS:"
        if (line === 'NIT :' || line === '-' || line === 'DPI:' ||
            line === 'CONDUEÑOS:' || line === 'CONDUE\u00d1OS:') {
          k++;
          continue;
        }
        // Stop at column headers or dates (we've left the co-owner block)
        if (isColumnHeader(line) || isDate(line)) break;
        // Skip page-break noise lines (headers, footers, etc.)
        k++;
      }
    }

    // First pass: labeled CONDUEÑOS section
    for (let j = section.startIdx; j < section.endIdx; j++) {
      if (lines[j] === 'CONDUEÑOS:' || lines[j] === 'CONDUE\u00d1OS:') {
        parseCoOwnerBlock(j + 1, section.endIdx);
        break;
      }
    }

    // Second pass: pick up continuation co-owners from page breaks
    // Page-break noise (headers like FECHA, dates) causes parseCoOwnerBlock to stop early,
    // so scan the full pre-property range looking only for NIT/name pairs
    const firstDateInSection = datePairs.find(
      dp => dp.fechaDeclIdx > section.startIdx && dp.fechaDeclIdx < section.endIdx
    );
    const scanEnd = firstDateInSection ? firstDateInSection.fechaDeclIdx : section.endIdx;
    for (let k = section.startIdx; k < scanEnd - 1; k++) {
      const line = lines[k];
      if ((line.match(/^\d+[-]\d+$/) || line.match(/^\d+[-][A-Z]$/)) &&
          lines[k + 1].match(/[A-Z]{2,}/) &&
          !matricula.coOwners.some(e => e.nit === line)) {
        matricula.coOwners.push({ nit: line, name: lines[k + 1] });
      }
    }

    // Find date pairs within this section
    const sectionPairs = datePairs.filter(
      dp => dp.fechaDeclIdx > section.startIdx && dp.fechaDeclIdx < section.endIdx
    );

    for (let pi = 0; pi < sectionPairs.length; pi++) {
      const pair = sectionPairs[pi];

      // Address: lines between previous property end and this date pair start
      // that aren't column headers, dashes, or numeric
      const addrStart = pi === 0
        ? section.startIdx
        : sectionPairs[pi - 1].fechaOperIdx + 1;

      const addressParts = [];
      for (let j = addrStart; j < pair.fechaDeclIdx; j++) {
        const l = lines[j];
        if (!isColumnHeader(l) && !isDashes(l) && !l.match(/^\d/) && l.length > 1) {
          addressParts.push(l);
        }
      }

      const address = addressParts
        .join(' ')
        // Remove page-break artifacts (Crystal Reports header/footer noise)
        .replace(/Nota Importante:.*?gratuita\.\s*/gi, '')
        .replace(/Main Report\s*/g, '')
        .replace(/Consulta realizada por el usuario:?\s*Consulta P[uú]blica\s*/g, '')
        .replace(/Guatemala C\.A\.\s*/g, '')
        .replace(/Miniterio de Finanzas P[uú]blicas\s*/g, '')
        .replace(/PAGINA:\s*/g, '')
        .replace(/HORA\s+Usuario\s*/g, '')
        .replace(/Consulta P[uú]blica\s*/g, '')
        .replace(/DE:\s*/g, '')
        .replace(/ESTADO MATRICULAR\s*/g, '')
        .replace(/MATRICULA FISCAL-DICABI\s*/g, '')
        .replace(/NOTA:.*?inmuebles:\s*/g, '')
        // Remove co-owner blocks: "NAME NIT : - DPI:" patterns repeated
        .replace(/CONDUEÑOS:[\s\S]*?(?=(?:FECHA|EDIF|LOTE|CASA|TERRENO|FINCA|BODEGA|APTO|DEPTO|PARQUEO|RESTO|LOCAL|SOLAR|PARCELA|\d{2}\/\d{2}\/\d{4}))/gi, '')
        .replace(/[\w\u00C0-\u024F\s,.()'"]+\s+NIT\s*:\s*-?\s*DPI:\s*/g, '')
        .replace(/NIT\s*:\s*-?\s*DPI:\s*/g, '')
        .replace(/\(\s*/g, '(')
        .replace(/\s*\)/g, ')')
        .replace(/\s+/g, ' ')
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .trim();

      // Data: lines from fechaDeclar to next property address or section end
      const dataEnd = pi + 1 < sectionPairs.length
        ? sectionPairs[pi + 1].fechaDeclIdx
        : section.endIdx;

      // Collect all data values from fechaDeclar to dataEnd
      // But stop collecting numeric values if we hit address text for next property
      const dataLines = [];
      for (let j = pair.fechaDeclIdx; j < dataEnd; j++) {
        const l = lines[j];
        if (isDashes(l) || isColumnHeader(l)) continue;
        // Stop if we hit text that looks like next address
        if (!l.match(/^\d/) && !l.match(/^\d{2}[A-Z]\d{6}$/) && l.match(/[A-Z]{2,}/) && dataLines.length > 3) {
          break;
        }
        dataLines.push(l);
      }

      // Parse data values positionally
      // Expected order after address:
      //   fechaDeclar, extension, fechaOperac, finca, folio, libro,
      //   valorFinca, de, procedencia, ordinal, valorTerreno,
      //   valorConstruccion, areaConstruccion, valorCultivos
      const property = { direccion: address || null };

      // Filter out dashes and headers from dataLines
      const vals = dataLines.filter(v => !isDashes(v) && !isColumnHeader(v));

      let vi = 0;
      // fechaDeclaracion
      if (vi < vals.length && isDate(vals[vi])) { property.fechaDeclaracion = vals[vi]; vi++; }
      // extension
      if (vi < vals.length) { property.extensionMts2 = parseNumber(vals[vi]); vi++; }
      // fechaOperacion
      if (vi < vals.length && isDate(vals[vi])) { property.fechaOperacion = vals[vi]; vi++; }
      // finca (can be alphanumeric like "31E")
      if (vi < vals.length) { property.finca = vals[vi].trim(); vi++; }
      // folio
      if (vi < vals.length) { const n = parseNumber(vals[vi]); if (n !== null) { property.folio = n; vi++; } }
      // libro
      if (vi < vals.length) { const n = parseNumber(vals[vi]); if (n !== null) { property.libro = n; vi++; } }
      // valorFinca
      if (vi < vals.length) { const n = parseNumber(vals[vi]); if (n !== null) { property.valorFincaQuetzales = n; vi++; } }
      // de (skip)
      if (vi < vals.length) { vi++; }
      // procedencia
      if (vi < vals.length && vals[vi].match(/^\d{2}[A-Z]\d{4,6}$/)) { property.procedencia = vals[vi]; vi++; }
      // ordinal (skip)
      if (vi < vals.length) { vi++; }
      // valorTerreno
      if (vi < vals.length) { property.valorTerreno = parseNumber(vals[vi]); vi++; }
      // valorConstruccion
      if (vi < vals.length) { property.valorConstruccion = parseNumber(vals[vi]); vi++; }
      // areaConstruccion
      if (vi < vals.length) { property.areaConstruccionMts2 = parseNumber(vals[vi]); vi++; }
      // valorCultivos
      if (vi < vals.length) { property.valorCultivos = parseNumber(vals[vi]); vi++; }

      matricula.properties.push(property);
    }

    // Merge with existing matricula of the same ID (multi-page reports)
    const existing = result.matriculas.find(m => m.id === matricula.id);
    if (existing) {
      existing.properties.push(...matricula.properties);
      for (const co of matricula.coOwners) {
        if (!existing.coOwners.some(e => e.nit === co.nit)) {
          existing.coOwners.push(co);
        }
      }
    } else {
      result.matriculas.push(matricula);
    }
  }

  // Extract totals
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('TOTALES DE LAS MATRICULAS')) {
      const nums = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (isDashes(lines[j])) break;
        const n = parseNumber(lines[j]);
        if (n !== null) nums.push(n);
      }
      if (nums.length >= 1) result.totalExtensionMts2 = nums[0];
      if (nums.length >= 2) result.totalValueQuetzales = nums[1];
      break;
    }
  }

  // Resolve the queried person's name
  if (queriedNit && result.registeredOwnerNit === queriedNit) {
    // The queried NIT is the registered owner
    result.name = result.registeredOwner;
  } else if (queriedNit) {
    // Look for the queried NIT in co-owners across all matriculas
    for (const m of result.matriculas) {
      const match = m.coOwners.find(co => co.nit === queriedNit);
      if (match) {
        result.name = match.name;
        break;
      }
    }
  }
  // Fallback: if we couldn't find the queried NIT in co-owners, use registered owner
  if (!result.name) {
    result.name = result.registeredOwner;
  }

  return result;
}

/**
 * Check if the current page is a Cloudflare block/rate-limit page.
 * Returns the block details if detected, null otherwise.
 */
async function checkCloudflareBlock(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const html = document.documentElement.innerHTML || '';
    const rayMatch = html.match(/Ray\s*ID[:\s]*([a-f0-9]+)/i) ||
                     text.match(/Ray\s*ID[:\s]*([a-f0-9]+)/i);
    if (rayMatch) {
      return { rayId: rayMatch[1], text: text.substring(0, 500) };
    }
    return null;
  });
}

async function scrape(taxId) {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

    const cfBlock = await checkCloudflareBlock(page);
    if (cfBlock) {
      throw new Error(`Blocked by Cloudflare (Ray ID: ${cfBlock.rayId}). Try again later.`);
    }

    const title = await page.title();
    if (title.includes('No disponible') || title.includes('Error')) {
      throw new Error(`Site is currently unavailable: "${title}"`);
    }

    // Select "Nit igual a" — triggers ASP.NET postback
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.select('#ctl00_ContentPlaceHolder1_ddlFiltro', 'Nit igual a'),
    ]);

    const cfBlockSelect = await checkCloudflareBlock(page);
    if (cfBlockSelect) {
      throw new Error(`Blocked by Cloudflare after select postback (Ray ID: ${cfBlockSelect.rayId}). Try again later.`);
    }

    await page.waitForSelector('#ctl00_ContentPlaceHolder1_txtDatoBuscar', { timeout: 10000 });

    // Type tax ID
    await page.click('#ctl00_ContentPlaceHolder1_txtDatoBuscar');
    await page.type('#ctl00_ContentPlaceHolder1_txtDatoBuscar', taxId, { delay: 50 });

    // Submit
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUT }).catch(() => {}),
      page.click('#ctl00_ContentPlaceHolder1_btnVerEstado'),
    ]);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const cfBlockPost = await checkCloudflareBlock(page);
    if (cfBlockPost) {
      throw new Error(`Blocked by Cloudflare after form submission (Ray ID: ${cfBlockPost.rayId}). Try again later.`);
    }

    const postTitle = await page.title();
    if (postTitle.includes('No disponible')) {
      throw new Error('Request was blocked by the website firewall. Try again later.');
    }

    // Check for "no data" message
    const messageEl = await page.$('#ctl00_ContentPlaceHolder1_lblMensaje');
    if (messageEl) {
      const message = await page.evaluate(el => el.textContent.trim(), messageEl);
      if (message) {
        const output = {
          id: taxId,
          idType: 'NIT',
          properties: [],
          message: message,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        return;
      }
    }

    // Extract report text — handle multi-page reports
    let bodyText = '';

    // Get total pages from the viewer (format: "1 / N")
    const pageInfo = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : null;
    });

    const totalPages = pageInfo ? pageInfo.total : 1;

    // Get text from first page
    bodyText += await page.evaluate(() => {
      const viewer = document.querySelector('[id*="CrystalReportViewer"]');
      return (viewer || document.body).innerText;
    });

    // Navigate through remaining pages if multi-page
    // Crystal Reports viewer nav buttons use name attributes (not id):
    //   ctl01=first, ctl04=prev, ctl05=next, ctl06=last
    // ctl04=first, ctl05=prev, ctl06=next, ctl07=last
    const nextBtnSelector = 'input[name="ctl00$ContentPlaceHolder1$CrystalReportViewer1$ctl02$ctl06"]';

    for (let pg = 2; pg <= totalPages; pg++) {
      const nextBtn = await page.$(nextBtnSelector);
      if (!nextBtn) break;

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUT }).catch(() => {}),
        nextBtn.click(),
      ]);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const cfBlockPage = await checkCloudflareBlock(page);
      if (cfBlockPage) {
        throw new Error(`Blocked by Cloudflare on page ${pg} of ${totalPages} (Ray ID: ${cfBlockPage.rayId}). Try again later.`);
      }

      bodyText += '\n' + await page.evaluate(() => {
        const viewer = document.querySelector('[id*="CrystalReportViewer"]');
        return (viewer || document.body).innerText;
      });
    }

    const report = parseReport(bodyText, taxId);

    const output = {
      id: taxId,
      idType: 'NIT',
      name: report.name,
      dpi: report.dpi,
    };

    if (report.note) output.note = report.note;

    output.matriculas = report.matriculas.map(m => {
      const mat = { id: m.id };
      // Include registered owner at matricula level when it differs from queried NIT
      if (report.registeredOwnerNit && report.registeredOwnerNit !== taxId) {
        mat.registeredOwner = { name: report.registeredOwner, nit: report.registeredOwnerNit };
      }
      mat.properties = m.properties;
      if (m.coOwners && m.coOwners.length > 0) mat.coOwners = m.coOwners;
      return mat;
    });

    output.totalExtensionMts2 = report.totalExtensionMts2;
    output.totalValueQuetzales = report.totalValueQuetzales;

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  } finally {
    await browser.close();
  }
}

function normalizeNit(input) {
  const stripped = input.replace(/[\s-]/g, '');
  if (stripped.length < 2) return input;
  // Insert dash before the last character (check digit)
  return stripped.slice(0, -1) + '-' + stripped.slice(-1);
}

function validateNit(nit) {
  const stripped = nit.replace(/-/g, '');
  if (stripped.length < 2) return false;
  const base = stripped.slice(0, -1);
  const checkChar = stripped.slice(-1).toUpperCase();
  const checkValue = checkChar === 'K' ? 10 : parseInt(checkChar);
  if (isNaN(checkValue)) return false;
  // Modulo 11 algorithm
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const digit = parseInt(base[i]);
    if (isNaN(digit)) return false;
    sum += digit * (base.length + 1 - i);
  }
  return (11 - (sum % 11)) % 11 === checkValue;
}

let taxId = process.argv[2];

if (!taxId) {
  process.stderr.write('Usage: node scraper.js <tax-id>\n');
  process.stderr.write('Example: node scraper.js 3737204-1\n');
  process.exit(1);
}

if (!taxId.includes('-')) {
  taxId = normalizeNit(taxId);
  process.stderr.write(`NIT normalized to: ${taxId}\n`);
}

if (!validateNit(taxId)) {
  process.stderr.write(`Error: Invalid NIT "${taxId}" (check digit does not match).\n`);
  process.exit(1);
}

scrape(taxId).catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
