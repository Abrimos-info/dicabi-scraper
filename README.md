# DICABI Scraper

CLI tool to extract property registration data from Guatemala's [DICABI](https://dicabienlinea.minfin.gob.gt/dicabi_enlinea/ConsultaEdoMat.aspx) website (Dirección de Catastro y Avalúo de Bienes Inmuebles).

Given a NIT (Número de Identificación Tributaria), it returns structured JSON with property details including addresses, valuations, registry data, and co-owners.

## Requirements

- Node.js 18+
- A display server (the browser must run in non-headless mode)

## Installation

```bash
npm install
```

## Usage

```bash
node scraper.js <NIT>
```

The NIT can be provided with or without the dash before the check digit:

```bash
node scraper.js 6603025-0    # with dash
node scraper.js 66030250     # without dash (auto-normalized)
node scraper.js 693921K      # K check digit
```

Output is JSON written to stdout. Errors and status messages go to stderr.

### Example output

Output is NDJSON (one JSON object per line):

```
{"id":"6603025-0","idType":"NIT","name":"SCHNEIDER MARTINEZ , CHRISTOPHER PAUL","dpi":"1704 99634 0101","matriculas":[{"id":"01S300102","properties":[{"direccion":"LOTE 9, 20 AVE Y (GUATEMALA / GUATEMALA)","fechaDeclaracion":"09/07/2012","extensionMts2":317.15,"fechaOperacion":"01/09/2012","finca":"1299","folio":23,"libro":92853,"valorFincaQuetzales":80000,"procedencia":"01S035111","valorTerreno":0,"valorConstruccion":0,"areaConstruccionMts2":0,"valorCultivos":0}]}],"totalExtensionMts2":981.45,"totalValueQuetzales":475000}
```

Pipe through `jq` for readable output:

```bash
node scraper.js 6603025-0 | jq .
```

### Output fields

| Field | Description |
|---|---|
| `id` | The queried NIT |
| `name` | Name associated with the queried NIT |
| `dpi` | DPI (Documento Personal de Identificación), if available |
| `note` | Present when the queried NIT is a co-owner, not the registered owner |
| `matriculas` | Array of matricula fiscal records |
| `matriculas[].id` | Matricula fiscal ID (e.g. `01R585038`) |
| `matriculas[].registeredOwner` | Present when the property owner differs from the queried NIT |
| `matriculas[].properties` | Array of properties under this matricula |
| `matriculas[].coOwners` | Array of co-owners, if any |
| `totalExtensionMts2` | Total area across all properties (square meters) |
| `totalValueQuetzales` | Total assessed value across all properties (Quetzales) |

### NIT validation

The tool validates NITs using Guatemala's Modulo 11 algorithm before querying the website. Invalid NITs are rejected immediately:

```
$ node scraper.js 1234567-0
Error: Invalid NIT "1234567-0" (check digit does not match).
```

## How it works

The DICABI website uses ASP.NET WebForms with an embedded Crystal Reports viewer. Standard HTTP requests are blocked by a WAF (Cloudflare), so the scraper uses a real browser via Puppeteer with a stealth plugin to bypass bot detection.

The browser **must run in non-headless mode** — headless mode is blocked by the WAF.

The report text is extracted from the Crystal Reports viewer's rendered output and parsed line-by-line using positional pattern matching. Multi-page reports are navigated automatically.

## Rate limiting

The website will rate-limit requests after too many in a short period. The scraper detects Cloudflare block pages and returns a clear error message with the Ray ID. If you get rate-limited, wait a few hours before retrying.

## License

ISC
