# English Devolution & LGR Database

A UNISON database of articles, documents and questions about **Local Government Reorganisation (LGR)** and **English Devolution (ED)**.

When someone adds a link, a document or a question, the entry is sent to Claude, Anthropic's AI model, in the background. Claude reads the article or document and assesses how relevant it is to UNISON and to the workforce of councils, combined authorities and strategic authorities. It then writes a **short briefing** and **key messages** into the entry.

## Fields

| Field | Notes |
| --- | --- |
| Unique ID | Assigned automatically |
| Link or document attachment | A web link, or an uploaded PDF, Word (.docx) or text document. An entry can also be a typed question |
| Category | LGR (Local Government Reorganisation) or ED (English Devolution) |
| Notes | Free text |
| Keywords | Comma-separated. If left blank, keywords suggested by the analysis are added |
| Date entered | Defaults to today and can be edited |
| UNISON region or National | National, or one of the 12 UNISON regions |
| Council or strategic authority | Free text, with suggestions from earlier entries |
| Relevance | High, Medium, Low or Not relevant, set by the analysis |
| Briefing | A 120–200 word briefing, written automatically |
| Key messages | Three to five key messages, written automatically |

You can search and filter entries by category, region and relevance, copy a briefing to the clipboard, re-analyse an entry, and export the whole database to CSV so it opens in Excel.

## Running it

You need [Node.js](https://nodejs.org/) 22 or later and an Anthropic API key from <https://console.anthropic.com>.

```bash
npm install
cp .env.example .env      # then add your ANTHROPIC_API_KEY to .env
npm start
```

Open <http://localhost:3000>.

Without an API key, entries are still saved but are not analysed. Once you have added a key and restarted, open an entry and choose **Re-analyse**.

### Settings (`.env`)

| Setting | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Needed for automatic analysis |
| `PORT` | `3000` | Web server port |
| `DATA_DIR` | `./data` | Where the SQLite database (`ed-lgr.db`) and uploaded documents are kept |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Claude model used for analysis |
| `ANALYSIS_EFFORT` | `high` | `low`, `medium` or `high`. Lower values are faster and cheaper |

## How the analysis works

1. The server reads the source. For a link it downloads the web page (or PDF). For a document it reads the PDF, Word or text file. For a question it uses the question and notes.
2. The source and the entry's details are sent to Claude with instructions to write, in British English, from a UNISON local government perspective. The instructions cover jobs, TUPE, pay and conditions, pensions (LGPS), equality, restructuring, bargaining and recognition.
3. Claude returns a relevance rating, the briefing, key messages and suggested keywords, and these are saved to the entry.

Some websites block automated downloads. When that happens the briefing is written from the details you entered, and the entry shows that the source could not be read. For those sites, save the page as a PDF and attach it instead.

Briefings are produced automatically. Check important facts against the source before using them.

## Backups

All data is in the `data/` folder. To back it up, copy that folder while the server is stopped.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # runs the automated tests
```

The code is organised as follows:

- `server.js` starts the server
- `src/app.js` holds the web routes and validation
- `src/db.js` is the SQLite database
- `src/content.js` reads links and documents
- `src/analyse.js` holds the Claude prompt and API call
- `src/queue.js` runs analyses in the background
- `public/` contains the web interface (HTML, CSS and JavaScript)
