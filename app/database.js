const helpers = require("./helpers.js")

const zmq = require("zeromq")
const Mutex = require("async-mutex").Mutex
const stripe = require("stripe")(process.env.STRIPE_KEY)
const Firestore = require("@google-cloud/firestore")
const firestore = new Firestore({
	projectId: "nlc-bot-36685",
})
const { ErrorReporting } = require("@google-cloud/error-reporting")
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

const accountsRef = firestore.collection("accounts")
const guildsRef = firestore.collection("discord").doc("properties").collection("guilds")
const unregisteredUsersRef = firestore.collection("discord").doc("properties").collection("users")

accountsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data()

		// Safety
		Object.keys(properties.apiKeys).forEach((key) => {
			delete properties.apiKeys[key].secret
			delete properties.apiKeys[key].passphrase
		})

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
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
		} else {
			const userId = accountProperties[accountId].oauth.discord.userId
			if (userId) {
				delete accountProperties[userId]
				delete accountIdMap[accountIdMap[accountId]]
				delete accountIdMap[accountId]
			}
			delete accountProperties[accountId]
		}
	})
	accountsReady = true
})
guildsRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const guildId = change.doc.id
		const properties = change.doc.data()

		// Validation
		if (isManager && guild_validation(guildId, properties)) return

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			guildProperties[guildId] = properties
		} else {
			delete guildProperties[guildId]
		}
	})
	guildsReady = true
})
unregisteredUsersRef.onSnapshot((querySnapshot) => {
	querySnapshot.docChanges().forEach((change) => {
		const accountId = change.doc.id
		const properties = change.doc.data()

		// Safety
		delete properties.connection
		delete properties.trace
		delete properties.credit
		if (helpers.isEmpty(properties)) return

		// Validation
		if (isManager && unregistered_user_validation(accountId, properties)) return

		// Prepare cache
		if (change.type === "added" || change.type === "modified") {
			if (!accountIdMap[accountId]) {
				accountProperties[accountId] = properties
			}
		} else {
			delete accountProperties[accountId]
		}
	})
	usersReady = true
})

const get_account_keys = function () {
	let response = {}
	Object.keys(accountProperties).forEach((accountId) => {
		const properties = accountProperties[accountId]
		if (properties.oauth) {
			response[accountId] = properties.oauth.discord.userId
		}
	})
	return response
}

const get_guild_keys = function () {
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
					if (process.env.PRODUCTION_MODE) errors.report(err)
				})
		} else {
			process_satellites(guildId, properties)
			response[guildId] = properties.settings.setup.connection
		}
	})
	return response
}

const guild_validation = function (guildId, properties) {
	if (!properties.addons || !properties.settings) {
		guildsRef.doc(guildId).set(helpers.create_guild_settings(properties))
		return true
	}
	if (properties.stale) {
		if (properties.stale.count >= 96) {
			guildsRef
				.doc(guildId)
				.delete()
				.catch((err) => {
					console.error(err)
					if (process.env.PRODUCTION_MODE) errors.report(err)
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
					if (process.env.PRODUCTION_MODE) errors.report(err)
				})
			return true
		}
	}
	if (process_satellites(guildId, properties)) {
		return true
	}
	if (!properties.addons.satellites.enabled && properties.addons.satellites.count) {
		guildsRef
			.doc(guildId)
			.set(
				{
					addons: {
						satellites: {
							enabled: false,
							count: Firestore.FieldValue.delete(),
							added: Firestore.FieldValue.delete(),
							connection: Firestore.FieldValue.delete(),
						},
					},
				},
				{
					merge: true,
				}
			)
			.catch((err) => {
				console.error(err)
				if (process.env.PRODUCTION_MODE) errors.report(err)
			})
		return true
	}
	return false
}

const unregistered_user_validation = function (accountId, properties) {
	if (helpers.isEmpty(properties)) {
		unregisteredUsersRef
			.doc(accountId)
			.delete()
			.catch((err) => {
				console.error(err)
				if (process.env.PRODUCTION_MODE) errors.report(err)
			})
		return true
	}
	return false
}

const process_satellites = function (guildId, properties) {
	if (properties.addons.satellites.enabled && properties.addons.satellites.added) {
		const satelliteCount = properties.addons.satellites.added.length
		if (satelliteCount > properties.addons.satellites.count) {
			if (accountProperties[properties.addons.satellites.connection] && accountProperties[properties.addons.satellites.connection].customer.personalSubscription.subscription) {
				if (process.env.PRODUCTION_MODE) {
					stripe.subscriptions.retrieve(accountProperties[properties.addons.satellites.connection].customer.personalSubscription.subscription, function (err, subscription) {
						if (err) {
							console.error(error)
							if (process.env.PRODUCTION_MODE) errors.report(error)
							return
						}
						const cycleRatio = (subscription.current_period_end - Math.floor(Date.now() / 1000)) / (subscription.current_period_end - subscription.current_period_start)
						const quantity = Math.floor(Math.ceil((satelliteCount - properties.addons.satellites.count) * 20 * cycleRatio))
						stripe.subscriptionItems.createUsageRecord(subscription.items.data[0].id, {
							quantity: quantity,
							timestamp: Math.floor(Date.now() / 1000),
							action: "increment",
						})
						guildsRef
							.doc(guildId)
							.set(
								{
									addons: {
										satellites: {
											enabled: true,
											count: satelliteCount,
										},
									},
								},
								{
									merge: true,
								}
							)
							.catch((err) => {
								console.error(err)
								if (process.env.PRODUCTION_MODE) errors.report(err)
							})
					})
					return true
				} else {
					console.log(guildId + ": " + satelliteCount + " satellites")
				}
			}
		}
	}
	return false
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
				response = guildProperties[entityId]
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
			if (process.env.PRODUCTION_MODE) errors.report(error)
		}
	}
}

main()
