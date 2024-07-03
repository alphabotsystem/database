import merge from "deepmerge"
import { GuildInfo } from "./types"

export const isEmpty = function (object: any) {
	return Object.keys(object).length === 0
}

export const create_guild_settings = function (settings: GuildInfo) {
	const settingsTemplate: GuildInfo = {
		charting: {
			theme: "dark",
			timeframe: "1-hour",
			indicators: [],
			chartType: "candles"
		},
		settings: {
			messageProcessing: {
				bias: "traditional",
				autodelete: null,
			},
			setup: {
				completed: false,
				connection: null,
				tos: 1.0,
			},
		},
	}

	if (isEmpty(settings)) settings = {} as GuildInfo
	return merge(settingsTemplate, settings)
}