import { htmlToMarkdown, isWeakMarkdown, metadataMarkdown, sqliteDateTime } from "../cloudflare/worker"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
	if (condition) {
		console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`)
		passed++
	} else {
		console.log(`  ✗ ${name}${detail ? ` (${detail})` : ""}`)
		failed++
	}
}

const spaShell = `<!doctype html>
<html>
	<head>
		<title>Ignitabull - Amazon PPC Management for Sellers</title>
		<meta name="description" content="Amazon PPC teardowns, audits, and management for sellers." />
		<meta property="og:description" content="Real money in Amazon. Real ads management." />
		<script type="application/ld+json">
			{
				"@context": "https://schema.org",
				"@type": "ProfessionalService",
				"name": "Ignitabull",
				"description": "Amazon PPC management for sellers that need campaign cleanup and approval-gated execution.",
				"serviceType": ["Amazon PPC cleanup", "Amazon Ads audit", "Amazon Ads management"],
				"offers": {
					"@type": "OfferCatalog",
					"itemListElement": [
						{ "@type": "Offer", "name": "Amazon PPC cleanup" },
						{ "@type": "Offer", "name": "Monthly Amazon PPC management" }
					]
				}
			}
		</script>
		<script type="module" src="/assets/app.js"></script>
	</head>
	<body><div id="root"></div></body>
</html>`

const staticResult = htmlToMarkdown(spaShell, "https://ignitabull.com/")
check("SPA shell static extraction is recognized as weak", isWeakMarkdown(staticResult.content))

const metadata = metadataMarkdown(spaShell, "https://ignitabull.com/")
check("Metadata fallback is not weak", !isWeakMarkdown(metadata), metadata)
check("Metadata fallback preserves description", metadata.includes("Amazon PPC teardowns"))
check("Metadata fallback preserves JSON-LD services", metadata.includes("Amazon Ads management"))
check("Metadata fallback preserves offers", metadata.includes("Monthly Amazon PPC management"))
check(
	"SQLite datetime format sorts with D1 datetime()",
	sqliteDateTime(new Date("2026-06-12T07:08:09.123Z")) === "2026-06-12 07:08:09",
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
