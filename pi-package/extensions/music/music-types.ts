export type MusicSource = "youtube" | "mixcloud" | "bandcamp" | "nts";

export interface MusicSection {
	startSeconds: number;
	title: string;
	artist?: string;
}

export interface MusicItem {
	id: string;
	source: MusicSource;
	title: string;
	artist?: string;
	album?: string;
	genres?: string[];
	inputUrl: string;
	streamUrl?: string;
	durationSeconds?: number;
	imageUrl?: string;
	username?: string;
	ntsChannel?: "1" | "2";
	ntsShowTitle?: string;
	sections?: MusicSection[];
	bandcampReleaseTracks?: MusicItem[];
	bandcampReleaseIndex?: number;
	addedAt: number;
}

export interface MusicLibrary {
	version: 1;
	watchlist: string[];
	bandcampWatchlist: string[];
	favorites: MusicItem[];
	history: MusicItem[];
}

export interface MusicRuntimeState {
	version: 1;
	current?: MusicItem;
	queue: MusicItem[];
	paused: boolean;
	lastPositionSeconds?: number;
}

export interface PlayerSnapshot {
	idle: boolean;
	paused: boolean;
	timePosSeconds?: number;
	durationSeconds?: number;
}

export interface AudioLevels {
	peakL: number; // 0-1 normalized
	peakR: number;
	rmsL: number;
	rmsR: number;
}

export interface NtsNowPlaying {
	channel: "1" | "2";
	showTitle?: string;
	trackTitle?: string;
	trackArtist?: string;
	startTimestamp?: string;
	endTimestamp?: string;
	sections?: MusicSection[];
}
