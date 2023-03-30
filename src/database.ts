import { isEmpty, create_guild_settings } from "./helpers.js"

import zmq from "zeromq"
import { Mutex } from "async-mutex"
import { Firestore, FieldValue } from "@google-cloud/firestore"
const firestore = new Firestore({
	projectId: "nlc-bot-36685",
})
import { ErrorReporting } from "@google-cloud/error-reporting"
import { AccountInfo, ApiExchangeId, DatabaseFeatureTag, GuildInfo, UserInfo } from "./types"
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

		console.log(change.type, "account", accountId)

		if (!process.env.PRODUCTION && properties.customer.stripeId !== "cus_Gy6zKofFgMzD6i") return

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

		console.log(change.type, "guild", guildId)

		if (!process.env.PRODUCTION && properties.settings.setup.connection !== "ebOX1w1N2DgMtXVN978fnL0FKCP2") return

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

		console.log(change.type, "user", accountId)

		if (!process.env.PRODUCTION && properties.connection !== "ebOX1w1N2DgMtXVN978fnL0FKCP2") return

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

const get_guild_properties = (guildId: string) => {
	let response = guildProperties[guildId]
	if (response && response.settings.setup.connection) {
		response.connection = accountProperties[response.settings.setup.connection]
	}
	return response
}

const get_account_keys = () => {
	let response: { [key: string]: string } = {}
	Object.keys(accountProperties).forEach((accountId) => {
		const properties = accountProperties[accountId]
		if (properties.oauth.discord.userId && !/^\d+$/.test(accountId)) {
			response[accountId] = properties.oauth.discord.userId
		}
	})
	return response
}

const get_guild_keys = () => {
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
			const entityId = message.pop()!.toString()
			const timestamp = message.pop()!.toString()
			const service = message.pop()!.toString()
			const delimiter = message.pop()!
			const origin = message.pop()!

			if (parseInt(timestamp) < Date.now()) continue

			let response: any
			if (service == "account_fetch") {
				response = accountProperties[entityId] ?? userProperties[entityId]
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
				await sock.send([origin, delimiter, JSON.stringify(response)])
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
