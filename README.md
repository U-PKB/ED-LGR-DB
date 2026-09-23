# English Devolution & LGR Database

A public UNISON database of articles, documents and questions about **Local Government Reorganisation (LGR)** and **English Devolution (ED)**. It runs entirely on GitHub.

- **Website:** <https://u-pkb.github.io/ED-LGR-DB/>. Search and filter entries, read briefings and export to CSV.
- **Add an entry:** [fill in the form](https://github.com/U-PKB/ED-LGR-DB/issues/new?template=new-entry.yml). You need a free GitHub account.

When an entry is added, a GitHub Action sends it to Claude, Anthropic's AI model. Claude reads the article or document and assesses how relevant it is to UNISON and to the workforce of councils, combined authorities and strategic authorities. It then writes a **short briefing** and **key messages**. The entry and its briefing appear on the website a minute or two later. The briefing is also posted as a comment on the entry.

## Fields

| Field | Where it comes from |
| --- | --- |
| Unique ID | The GitHub issue number |
| Title or question | The issue title |
| Link or document attachment | A web link, or a PDF, Word (.docx) or text file dragged into the form |
| Category | LGR (Local Government Reorganisation) or ED (English Devolution) |
| UNISON region or National | National, or one of the 12 UNISON regions |
| Council or strategic authority | Free text |
| Date entered | DD/MM/YYYY. If left blank, the date the entry was added is used |
| Keywords | Comma-separated. If left blank, keywords suggested by the analysis are added |
| Notes | Free text |
| Relevance, briefing, key messages | Written automatically |

## Managing entries

Each entry is a GitHub issue.

| To… | Do this on the entry's GitHub issue |
| --- | --- |
| Edit an entry | Edit the issue. The briefing is written again when the title or form is changed |
| Re-write the briefing | Add the **reanalyse** label |
| Remove an entry | Close the issue. Reopening it puts it back |
| Approve an entry from someone outside the repository | Add the **approved** label |

Anyone with a GitHub account can open an issue on a public repository. To stop strangers adding entries or using up your API credit, entries from people who are not owners or collaborators on the repository are held with the **awaiting approval** label until a maintainer adds **approved**. To let colleagues add entries directly, invite them as collaborators under **Settings → Collaborators**.

## One-off setup

These steps are done once by the repository owner.

1. **Make the repository public.** Go to **Settings → General → Danger Zone → Change visibility**. GitHub Pages is free for public repositories.
2. **Add the API key.** Go to **Settings → Secrets and variables → Actions → New repository secret**. Name it `ANTHROPIC_API_KEY` and paste in a key from <https://console.anthropic.com>.
3. **Turn on the website.** Go to **Settings → Pages** and under **Build and deployment → Source** choose **GitHub Actions**.
4. **Allow the Actions to save entries.** Go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**.
5. **Publish the site for the first time.** Go to **Actions → Publish website → Run workflow**.

The Actions run from the repository's **default branch**, which you can set under **Settings → General**. Keep all of the code on that branch.

Without the API key, entries are still saved and shown, marked as not analysed. Once the key is added, put the **reanalyse** label on them.

### Settings

You can change these optional repository variables under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Claude model used for analysis |
| `ANALYSIS_EFFORT` | `high` | `low`, `medium` or `high`. Lower values are faster and cheaper |

## How the analysis works

1. The Action reads the source. For a link it downloads the web page (or PDF). For an attached document it reads the PDF, Word or text file. For a question it uses the title and notes.
2. The source and the entry's details are sent to Claude with instructions to write, in British English, from a UNISON local government perspective. The instructions cover jobs, TUPE, pay and conditions, pensions (LGPS), equality, restructuring, bargaining and recognition.
3. Claude returns a relevance rating (High, Medium, Low or Not relevant), a briefing, key messages and suggested keywords.
4. These are saved to `data/entries/<ID>.json` and the website is republished.

Some websites block automated downloads. When that happens the briefing is written from the details entered, and the entry says that the source could not be read. For those sites, save the page as a PDF and attach it instead.

Briefings are produced automatically. Check important facts against the source before using them.

## Development

```bash
npm install
npm test               # automated tests
npm run build          # builds the website into _site/ from data/entries
```

The code is organised as follows:

- `.github/ISSUE_TEMPLATE/new-entry.yml` is the "Add an entry" form
- `.github/workflows/entries.yml` processes an entry when its issue changes
- `.github/workflows/pages.yml` publishes the website
- `scripts/process-issue.js` turns an issue into an entry, runs the analysis and comments on the issue
- `scripts/build-site.js` combines the entries into the website
- `src/analyse.js` holds the Claude prompt and API call
- `src/content.js` reads links and documents
- `src/issue.js` reads the issue form
- `site/` contains the website (HTML, CSS and JavaScript)
- `data/entries/` holds one JSON file per entry
