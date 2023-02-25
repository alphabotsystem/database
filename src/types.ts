export interface AccountInfo {
	apiKeys: {
		binance?: {
			key: string
			secret: string
			passphrase?: string
		}
		binancefutures?: {
			key: string
			secret: string
			passphrase?: string
		}
	}
	customer: {
		slots: { [feature in DatabaseFeatureTag]: {
			[key: string]: { enabled?: boolean, added?: string[] } }
		}
		subscriptions: { [feature in DatabaseFeatureTag]: number }
		stripeId: string
	}
	oauth: {
		discord: {
			accessToken?: string
			expiry?: number
			userId?: string
		}
	}
	paperTrader?: {
		globalLastReset: number
		globalResetCount: number
		balance?: {
			IEXC?: { [key:string]: number }
			CCXT?: { [key:string]: number }
			USD: number
		}
	}
}

export interface UserInfo {
	connection?: string
	credit?: number
	paperTrader?: {
		globalLastReset: number
		globalResetCount: number
		balance?: {
			IEXC?: { [key:string]: number }
			CCXT?: { [key:string]: number }
			USD: number
		}
	}
}

export interface GuildInfo {
	stale?: {
		count: number
		timestamp: number
	}
	connection?: AccountInfo
	charting: {
		theme: ChartTheme
		timeframe: string
		indicators: string[]
		chartType: ChartType
	}
	settings: {
		assistant: {
			enabled: boolean
		}
		messageProcessing: {
			autodelete: boolean
			bias: ParserOptions
		}
		setup: {
			completed: boolean
			connection: null | string
			tos: number
		}
	}
}

export type ApiExchangeId = "binance" | "binancefutures"
export type DatabaseFeatureTag = "satellites" | "advancedCharting" | "scheduledPosting" | "priceAlerts" | "botLicense"

export type ChartTheme = "light" | "dark"
export type ChartType = "bars" | "candles" | "line" | "area" | "renko" | "kagi" | "point&Figure" | "line break" | "heikin ashi" | "hollow candles" | "baseline" | "hiLo" | "column"
export type ParserOptions = "traditional" | "crypto"