# DICABI Scraper

Node.js CLI tool to extract property registration data from Guatemala's DICABI website (Dirección de Catastro y Avalúo de Bienes Inmuebles).

## Usage

```bash
node scraper.js <NIT>
```

Outputs structured JSON to stdout with owner info, matriculas, properties, co-owners, and totals.

## Dependencies

- `puppeteer-extra` + `puppeteer-extra-plugin-stealth` — required to bypass the site's WAF (Web Application Firewall)
- `puppeteer` — headless Chromium automation

## Important Technical Details

### Bot Detection / WAF
- Raw HTTP requests (curl, fetch) get **403 Forbidden**
- Puppeteer in headless mode gets blocked on POST requests ("Sitio no permitido")
- **Must run with `headless: false`** — headless mode does not work
- The stealth plugin is required even in non-headless mode
- `--no-sandbox` is required on this Linux system (AppArmor restriction)

### ASP.NET WebForms
The site uses ASP.NET WebForms with postback. Key selectors:
- Select dropdown: `#ctl00_ContentPlaceHolder1_ddlFiltro`
- Text input: `#ctl00_ContentPlaceHolder1_txtDatoBuscar`
- Submit button: `#ctl00_ContentPlaceHolder1_btnVerEstado` (type="image", not "submit")
- Message label: `#ctl00_ContentPlaceHolder1_lblMensaje`

Changing the select triggers `__doPostBack` — must use `page.select()` with `waitForNavigation`.

### Crystal Reports Viewer
- Results render via an embedded Crystal Reports viewer, not HTML tables
- Data is extracted from `document.body.innerText`
- Report text contains Unicode RTL markers (U+200E/200F) and non-breaking spaces (U+00A0) that must be cleaned
- Multi-page reports use nav buttons: next = `ctl00$ContentPlaceHolder1$CrystalReportViewer1$ctl02$ctl06`

### Report Parsing
Property data appears one-per-line in fixed order after each address block:
```
[Address lines]
DD/MM/YYYY          ← fecha declaracion
 123.45             ← extension mts2
DD/MM/YYYY          ← fecha operacion
finca, folio, libro, valorFinca, de, procedencia, ordinal,
valorTerreno, valorConstruccion, areaConstruccion, valorCultivos
```

Date pairs (2 dates separated by exactly 1 line) are the anchor for detecting property boundaries.

### Known Limitations
- Finca/folio/libro order may differ between visual report and innerText for some properties
- Non-headless mode is mandatory (opens a visible browser window)
- Site may rate-limit after many requests — timeout is set to 60s

## Test NITs

| NIT | Description |
|---|---|
| `3737204-1` | No properties registered |
| `7415663-2` | 2 properties under matricula 01R585038 |
| `77077-9` | 1 property + 40 co-owners (multi-page report, co-owner only) |
| `4709900-3` | 13 properties, multi-page report |
| `293850-2` | 1 property |
| `6119178-7` | 1 property |
| `250448-0` | 1 property |
| `6603025-0` | 2 properties across 2 matriculas |
| `693921-K` | 1 property (K check digit) |
| `2742339-5` | 1 property |
