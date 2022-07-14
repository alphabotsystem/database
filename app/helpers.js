const merge = require("deepmerge")

const isEmpty = function (object) {
	return Object.keys(object).length === 0
}

const create_guild_settings = function (settings) {
	const settingsTemplate = {
		addons: {
			satellites: { enabled: false },
			marketAlerts: { enabled: false },
		},
		settings: {
			assistant: {
				enabled: true,
			},
			messageProcessing: {
				bias: "traditional",
				autodelete: false,
			},
			setup: {
				completed: false,
				connection: null,
				tos: 1.0,
			},
		},
	}

	if (isEmpty(settings)) settings = {}
	return merge(settingsTemplate, settings)
}

module.exports = { create_guild_settings, isEmpty }
