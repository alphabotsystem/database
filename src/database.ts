import { isEmpty, create_guild_settings } from "./helpers.js"

import express from "express"
import { Firestore, FieldValue } from "@google-cloud/firestore"
import { ErrorReporting } from "@google-cloud/error-reporting"
import { AccountInfo, ApiExchangeId, DatabaseFeatureTag, GuildInfo, UserInfo } from "./types"

const app = express()
const firestore = new Firestore({
	projectId: "nlc-bot-36685",
})
const errors = new ErrorReporting()

const isManager = process.env.HOSTNAME!.split("-").length == 2 && process.env.HOSTNAME!.split("-")[1] == "0"
if (isManager) console.log("[Startup]: This instance is a database manager")
else console.log("[Startup]: This instance is a slave")

let accountProperties: { [accountId: string]: AccountInfo } = {}
let userProperties: { [accountId: string]: UserInfo } = {}
let guildProperties: { [guildId: string]: GuildInfo } = {}
let accountIdMap: { [key: string]: string } = {}

let accountsReady = false
let guildsReady = false
let usersReady = false

const accountsRef = firestore.collection("accounts")
const guildsRef = firestore.collection("discord").doc("properties").collection("guilds")
const unregisteredUsersRef = firestore.collection("discord").doc("properties").collection("users")

accountsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data() as AccountInfo

		if (!process.env.PRODUCTION && properties.customer.stripeId !== "cus_Gy6zKofFgMzD6i") return
		console.log(change.type, "account", accountId)

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			// Validation
			if (isManager && account_validation(accountId, properties)) return

			// Safety
			Object.keys(properties.apiKeys).forEach((key) => {
				properties.apiKeys[key as ApiExchangeId]!.secret = "************"
				properties.apiKeys[key as ApiExchangeId]!.passphrase = "************"
			})
			delete properties.oauth.discord.accessToken

			accountProperties[accountId] = properties
			const userId = properties.oauth.discord.userId
			if (userId) {
				accountProperties[userId] = properties
				accountIdMap[userId] = accountId
				accountIdMap[accountId] = userId
			} else if (accountIdMap[accountId]) {
				if (userId) delete accountProperties[userId]
				delete accountIdMap[accountIdMap[accountId]]
				delete accountIdMap[accountId]
			}
		} else if (change.type === "removed") {
			const userId = accountProperties[accountId].oauth.discord.userId
			if (userId) {
				delete accountProperties[userId]
				delete accountIdMap[accountIdMap[accountId]]
				delete accountIdMap[accountId]
			}
			delete accountProperties[accountId]
		} else {
			console.error("unknown change type: " + change.type)
		}
	})
	accountsReady = true
}, (error) => {
	console.error("Error getting accounts: " + error)
	process.exit(1)
})

guildsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const guildId = change.doc.id
		const properties = change.doc.data() as GuildInfo

		if (!process.env.PRODUCTION && properties.settings.setup.connection !== "ebOX1w1N2DgMtXVN978fnL0FKCP2") return
		console.log(change.type, "guild", guildId)

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			// Validation
			if (isManager && guild_validation(guildId, properties)) return

			guildProperties[guildId] = properties
		} else if (change.type === "removed") {
			delete guildProperties[guildId]
		} else {
			console.error("unknown change type: " + change.type)
		}
	})
	guildsReady = true
}, (error) => {
	console.error("Error getting guilds: " + error)
	process.exit(1)
})

unregisteredUsersRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data() as UserInfo

		if (!process.env.PRODUCTION && properties.connection !== "ebOX1w1N2DgMtXVN978fnL0FKCP2") return
		console.log(change.type, "user", accountId)

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			// Validation
			if (isManager && unregistered_user_validation(accountId, properties)) return

			// Safety
			delete properties.connection
			delete properties.credit
			if (isEmpty(properties)) return

			if (!accountIdMap[accountId]) {
				userProperties[accountId] = properties
			}
		} else if (change.type === "removed") {
			delete userProperties[accountId]
		} else {
			console.error("unknown change type: " + change.type)
		}
	})
	usersReady = true
}, (error) => {
	console.error("Error getting unregistered users: " + error)
	process.exit(1)
})

const account_validation = (accountId: string, properties: AccountInfo) => {
	if (!properties.customer) {
		return true
	}
	let modified = false
	Object.keys(properties.customer.slots).forEach((feature) => {
		Object.keys(properties.customer.slots[feature as DatabaseFeatureTag]).forEach((slot) => {
			let slotDetails = properties.customer.slots[feature as DatabaseFeatureTag][slot]
			if (slotDetails.enabled === false) {
				delete properties.customer.slots[feature as DatabaseFeatureTag][slot]
				modified = true
			} else if (slotDetails.added && slotDetails.added.length === 0) {
				delete properties.customer.slots[feature as DatabaseFeatureTag][slot]
				modified = true
			}
		})
	})
	if (modified) {
		accountsRef.doc(accountId).set(properties)
		return true
	}
	return false
}

const guild_validation = (guildId: string, properties: GuildInfo) => {
	if (!properties.settings || !properties.charting) {
		guildsRef.doc(guildId).set(create_guild_settings(properties))
		return true
	}
	if (properties.stale) {
		if (properties.stale.count >= 96) {
			guildsRef
				.doc(guildId)
				.delete()
				.catch((err) => {
					console.error(err)
					if (process.env.PRODUCTION) errors.report(err)
				})
			return true
		} else if (properties.stale.timestamp <= Math.floor(Date.now() / 1000) - 86400) {
			guildsRef
				.doc(guildId)
				.set(
					{
						stale: FieldValue.delete(),
					},
					{
						merge: true,
					}
				)
				.catch((err) => {
					console.error(err)
					if (process.env.PRODUCTION) errors.report(err)
				})
			return true
		}
	}
	return false
}

const unregistered_user_validation = (accountId: string, properties: UserInfo) => {
	if (properties.connection === null && Object.keys(properties).length === 1) {
		unregisteredUsersRef
			.doc(accountId)
			.delete()
			.catch((err) => {
				console.error(err)
				if (process.env.PRODUCTION) errors.report(err)
			})
		return true
	}
	return false
}

app.use(express.json())

app.post("/account/fetch", async (req, res) => {
	const accountId = req.body.key as string | undefined
	if (!accountId) {
		console.log("Account ID not provided")
		res.status(400).send({ response: null })
		return
	}

	res.send({ response: accountProperties[accountId] ?? userProperties[accountId] })
})

app.post("/guild/fetch", async (req, res) => {
	const guildId = req.body.key as string | undefined
	if (!guildId) {
		console.log("Guild ID not provided")
		res.status(400).send({ response: null })
		return
	}

	let response = guildProperties[guildId]
	if (response && response.settings.setup.connection) {
		response.connection = accountProperties[response.settings.setup.connection]
	}

	res.send({ response: response })
})

app.post("/account/keys", async (req, res) => {
	let response: { [key: string]: string } = {}
	Object.keys(accountProperties).forEach((accountId) => {
		const properties = accountProperties[accountId]
		if (properties.oauth.discord.userId && !/^\d+$/.test(accountId)) {
			response[accountId] = properties.oauth.discord.userId
		}
	})

	res.send({ response: response })
})

app.post("/guild/keys", async (req, res) => {
	let response: { [key: string]: string | null } = {}
	Object.keys(guildProperties).forEach((guildId) => {
		const properties = guildProperties[guildId]
		if (properties.stale && properties.stale.timestamp <= Math.floor(Date.now() / 1000) - 3600) {
			guildsRef
				.doc(guildId)
				.set(
					{
						stale: FieldValue.delete(),
					},
					{
						merge: true,
					}
				)
				.catch((err) => {
					console.error(err)
					if (process.env.PRODUCTION) errors.report(err)
				})
		} else {
			response[guildId] = properties.settings.setup.connection
		}
	})

	res.send({ response: response })
})

app.post("/account/match", async (req, res) => {
	const accountId = req.body.key as string | undefined
	if (!accountId) {
		console.log("Account ID not provided")
		res.status(400).send({ response: null })
		return
	}

	res.send({ response: accountIdMap[accountId] })
})

app.post("/account/status", async (req, res) => {
	res.send({ response: accountsReady && usersReady })
})

app.post("/guild/status", async (req, res) => {
	res.send({ response: accountsReady && guildsReady })
})

const server = app.listen(6900, () => {
	console.log("[Startup]: Database server is online")
})

const shutdown = () => {
	server.close(() => {
		console.log("[Shutdown]: Database server is offline")
		process.exit(0)
	})
}

process.on("SIGTERM", () => {
	shutdown()
})
