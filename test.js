const { ImapFlow } = require("imapflow");
const client = new ImapFlow({
	host: "mail.enjoys.in",
	port: 993,
	logger: true,
	secure: true,
	auth: {
		user: "mullayam06@airsend.in",
		pass: "0b9354201b45848a",
	},
});

async function listMailboxes() {
	try {
		await client.connect();
		// const mailboxes = await client.list();
		// console.log("Mailboxes:", mailboxes);
	} catch (error) {
		console.error("Error listing mailboxes:", error);
	}
}
listMailboxes();
