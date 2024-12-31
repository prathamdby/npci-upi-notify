import axios from "axios";
import * as cheerio from "cheerio";
import { Octokit } from "octokit";
import { config } from "dotenv";

config();

const SITE_URL = process.env.SITE_URL;
const USER_TOKEN = process.env.USER_TOKEN;
const GIST_ID = process.env.GIST_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!SITE_URL || !USER_TOKEN || !GIST_ID || !WEBHOOK_URL) {
	throw new Error("Missing environment variables");
}

const octokit = new Octokit({
	auth: USER_TOKEN,
});

const fetchPageHTML = async (retries = 3, delay = 1000) => {
	try {
		const { data } = await axios.get(SITE_URL);

		return data;
	} catch (error) {
		if (retries > 0) {
			console.log(`Retrying... ${retries} attempts left`);
			await new Promise((resolve) => setTimeout(resolve, delay));
			return fetchPageHTML(retries - 1, delay);
		}
		throw new Error(
			`Failed to fetch page after multiple attempts: ${error.message}`,
		);
	}
};

const fetchTableHTML = async () => {
	try {
		const html = await fetchPageHTML();
		if (!html) {
			throw new Error("No HTML content received");
		}

		const $ = cheerio.load(html);
		const table = $(".table-responsive > table");

		if (!table.length) {
			throw new Error("Table not found in the HTML content");
		}

		const tableHtml = table.html();
		if (!tableHtml) {
			throw new Error("Table content is empty");
		}

		return tableHtml;
	} catch (error) {
		console.error("Error fetching table HTML:", error.message);
		throw error;
	}
};

function parseTableToJSON(tableHTML) {
	const cleanHTML = tableHTML.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

	const result = [];
	let currentEntry = null;

	const rows = cleanHTML.split("<tr>").slice(2); // Skip header row

	for (const row of rows) {
		if (!row.trim()) continue;

		const tdContents = row.match(/<td[^>]*>(.*?)<\/td>/g) || [];
		const cells = tdContents.map((td) => {
			const content = td
				.replace(/<td[^>]*>/, "")
				.replace(/<\/td>/, "")
				.replace(/<a[^>]*>/, "")
				.replace(/<\/a>/, "")
				.replace(/\s+/g, " ")
				.trim();
			return content;
		});

		const urlMatch = row.match(/href="([^"]+)"/);
		const url = urlMatch ? urlMatch[1] : "";

		if (cells.length === 0) continue;

		const firstCell = cells[0];
		if (/^\d+$/.test(firstCell)) {
			if (currentEntry) {
				result.push(currentEntry);
			}

			currentEntry = {
				srNo: firstCell,
				tpap: cells[1],
				goLive: cells[2],
				pspBanks: [
					{
						bank: cells[3],
						handleName: cells[4],
					},
				],
				linksURL: url || cells[5],
			};
		} else if (currentEntry && cells.length >= 2) {
			currentEntry.pspBanks.push({
				bank: cells[0],
				handleName: cells[1],
			});
		}
	}

	if (currentEntry) {
		result.push(currentEntry);
	}

	return result;
}

const fetchGist = async () => {
	try {
		const response = await octokit.request("GET /gists/{gist_id}", {
			gist_id: GIST_ID,
		});

		return response.data;
	} catch (error) {
		console.error("Error fetching Gist:", error.message);
		throw error;
	}
};

const updateGist = async (gistID, data) => {
	try {
		await octokit.request("PATCH /gists/{gist_id}", {
			gist_id: gistID,
			description: "Updated PSP Banks list",
			files: {
				"psp-banks.json": {
					content: data,
					filename: "psp-banks.json",
				},
			},
			headers: {
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});

		console.log("Gist updated successfully");
	} catch (error) {
		console.error("Error updating Gist:", error.message);
		throw error;
	}
};

const main = async () => {
	const tableHTML = await fetchTableHTML();
	const tableJSON = parseTableToJSON(tableHTML);
	const currentContent = JSON.stringify(tableJSON, null, 2);

	const gist = await fetchGist();
	const gistID = gist.id;
	const gistContent = gist.files["psp-banks.json"].content;

	if (gistContent !== currentContent) {
		const currentData = tableJSON;
		const gistData = JSON.parse(gistContent);

		const newEntries = currentData.filter(
			(currentEntry) =>
				!gistData.some((gistEntry) => gistEntry.srNo === currentEntry.srNo),
		);

		if (newEntries.length) {
			for (const entry of newEntries) {
				await axios.post(WEBHOOK_URL, {
					content: null,
					embeds: [
						{
							title: "New 3rd party UPI app added!",
							description: `Name: **${entry.tpap}**\nWent live: **${entry.goLive}**${entry.linksURL.startsWith("https://") ? `\nLink: ${entry.linksURL}` : ""}\n\n**Partner Bank(s):**`,
							color: null,
							fields: entry.pspBanks.map((bank) => ({
								name: bank.bank,
								value: bank.handleName,
								inline: true,
							})),
						},
					],
				});

				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} else {
			console.log("No new entries found in the table");
		}

		await updateGist(gistID, currentContent);
	} else {
		console.log("No changes detected in the table content");
	}
};

main()
	.then(() => console.log("Program ran successfully"))
	.catch((error) =>
		console.error("An error occurred while running the main function:", error),
	);
