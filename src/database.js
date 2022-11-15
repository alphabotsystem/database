import { isEmpty, create_guild_settings } from "./helpers.js"

import zmq from "zeromq"
import { Mutex } from "async-mutex"
import { Firestore } from "@google-cloud/firestore"
const firestore = new Firestore({
	projectId: "nlc-bot-36685",
})
import { ErrorReporting } from "@google-cloud/error-reporting"
const errors = new ErrorReporting()

const isManager = process.env.HOSTNAME.split("-").length == 2 && process.env.HOSTNAME.split("-")[1] == "0"
if (isManager) console.log("[Startup]: This instance is a database manager")
else console.log("[Startup]: This instance is a slave")

let accountProperties = {}
let guildProperties = {}
let accountIdMap = {}

let accountsReady = false
let guildsReady = false
let usersReady = false

const accountsRef = process.env.PRODUCTION
	? firestore.collection("accounts")
	: firestore.collection("accounts").where("customer.stripeId", "==", "cus_Gy6zKofFgMzD6i")
const guildsRef = process.env.PRODUCTION
	? firestore.collection("discord").doc("properties").collection("guilds")
	: firestore.collection("discord").doc("properties").collection("guilds").where("settings.setup.connection", "==", "ebOX1w1N2DgMtXVN978fnL0FKCP2")
const unregisteredUsersRef = process.env.PRODUCTION
	? firestore.collection("discord").doc("properties").collection("users")
	: firestore.collection("discord").doc("properties").collection("users").where("connection", "==", "ebOX1w1N2DgMtXVN978fnL0FKCP2")

accountsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data()

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			// Safety
			Object.keys(properties.apiKeys).forEach((key) => {
				delete properties.apiKeys[key].secret
				delete properties.apiKeys[key].passphrase
			})
			delete properties.oauth.discord.accessToken
			delete properties.oauth.discord.tokenType

			accountProperties[accountId] = properties
			const userId = properties.oauth.discord.userId
			if (userId) {
				accountProperties[userId] = properties
				accountIdMap[userId] = accountId
				accountIdMap[accountId] = userId
			} else if (accountIdMap[accountId]) {
				delete accountProperties[userId]
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
})
guildsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const guildId = change.doc.id
		const properties = change.doc.data()

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
})
unregisteredUsersRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data()

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			// Validation
			if (isManager && unregistered_user_validation(accountId, properties)) return

			// Safety
			delete properties.connection
			delete properties.trace
			delete properties.credit
			if (isEmpty(properties)) return

			if (!accountIdMap[accountId]) {
				accountProperties[accountId] = properties
			}
		} else if (change.type === "removed") {
			delete accountProperties[accountId]
		} else {
			console.error("unknown change type: " + change.type)
		}
	})
	usersReady = true
})

const guild_validation = (guildId, properties) => {
	if (!properties.settings) {
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
						stale: Firestore.FieldValue.delete(),
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

const unregistered_user_validation = (accountId, properties) => {
	if (properties.connection === null && properties.trace === null && Object.keys(properties).length === 2) {
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

const get_guild_properties = (guildId) => {
	let response = guildProperties[guildId]
	if (response) {
		response.connection = accountProperties[response.settings.setup.connection]
	}
	return response
}

const get_account_keys = () => {
	let response = {}
	Object.keys(accountProperties).forEach((accountId) => {
		const properties = accountProperties[accountId]
		if (properties.oauth && !/^\d+$/.test(accountId)) {
			response[accountId] = properties.oauth.discord.userId
		}
	})
	return response
}

const get_guild_keys = () => {
	let response = {}
	Object.keys(guildProperties).forEach((guildId) => {
		const properties = guildProperties[guildId]
		if (properties.stale && properties.stale.timestamp <= Math.floor(Date.now() / 1000) - 86400) {
			guildsRef
				.doc(guildId)
				.set(
					{
						stale: Firestore.FieldValue.delete(),
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
	return response
}

const main = async () => {
	console.log("[Startup]: Database server is online")

	const mutex = new Mutex()
	const sock = new zmq.Router()
	await sock.bind("tcp://*:6900")

	while (true) {
		try {
			const message = await sock.receive()

			// Pop received data and decode it
			const entityId = message.pop().toString()
			const timestamp = message.pop().toString()
			const service = message.pop().toString()
			const delimeter = message.pop()
			const origin = message.pop()

			if (parseInt(timestamp) < Date.now()) continue

			let response = {}

			if (service == "account_fetch") {
				response = accountProperties[entityId]
			} else if (service == "guild_fetch") {
				response = get_guild_properties(entityId)
			} else if (service == "account_keys") {
				response = get_account_keys()
			} else if (service == "guild_keys") {
				response = get_guild_keys()
			} else if (service == "account_match") {
				response = accountIdMap[entityId]
			} else if (service == "account_status") {
				response = accountsReady && usersReady
			} else if (service == "guild_status") {
				response = accountsReady && guildsReady
			}

			mutex.runExclusive(async () => {
				await sock.send([origin, delimeter, JSON.stringify(response)])
			})
		} catch (error) {
			console.error(error)
			if (process.env.PRODUCTION) errors.report(error)
		}
	}
}

main()

const shutdown = () => {
	console.log("[Shutdown]: Database server is offline")
	process.exit(0)
}

process.on("SIGTERM", () => {
	shutdown()
})
