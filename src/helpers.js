import merge from "deepmerge"

export const isEmpty = function (object) {
	return Object.keys(object).length === 0
}

export const create_guild_settings = function (settings) {
	const settingsTemplate = {
		charting: {
			theme: "dark",
			timeframe: "1-hour",
			indicators: [],
			chartType: "candles"
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