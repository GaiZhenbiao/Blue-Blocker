import { api, logstr, EventKey, ErrorEvent } from '../constants';
import { BlockBlueVerified } from '../shared';
// This file contains a bit of a special case for responses. many responses
// on twitter contain a shared type stored in an "instructions" key within
// the response body. since it doesn't match one specific request, it has
// its own file

// when parsing a timeline response body, these are the paths to navigate in the json to retrieve the "instructions" object
// the key to this object is the capture group from the request regex in inject.js
const InstructionsPaths: { [key: string]: string[] } = {
	HomeLatestTimeline: [
		"data",
		"home",
		"home_timeline_urt",
		"instructions",
	],
	HomeTimeline: [
		"data",
		"home",
		"home_timeline_urt",
		"instructions",
	],
	SearchTimeline: [
		"data",
		"search_by_raw_query",
		"search_timeline",
		"timeline",
		"instructions",
	],
	UserTweets: [
		"data",
		"user",
		"result",
		"timeline_v2",
		"timeline",
		"instructions",
	],
	TweetDetail: [
		"data",
		"threaded_conversation_with_injections_v2",
		"instructions",
	],
	"search/adaptive.json": [
		"timeline",
		"instructions",
	],
};
// this is the path to retrieve the user object from the individual tweet
const UserObjectPath: string[] = [
	"tweet_results",
	"result",
	"tweet",
	"core",
	"user_results",
	"result",
];
const IgnoreTweetTypes = new Set([
	"TimelineTimelineCursor",
]);
const PromotedStrings = new Set([
	"suggest_promoted",
	"Promoted",
	"promoted",
]);

function handleTweetObject(obj: any, config: Config, promoted: boolean) {
	let ptr = obj;
	let full_text = null;
	for (const key of UserObjectPath) {
		if (ptr.hasOwnProperty(key)) {
			if (key === 'core') {
				full_text = ptr["legacy"].full_text;
			}
			ptr = ptr[key];
		}
	}
	if (ptr.__typename !== 'User') {
		console.error(logstr, 'could not parse tweet', obj);
		return;
	}
	ptr.promoted_tweet = promoted;
	if (full_text !== null) {
		ptr.full_text = full_text;
	}
	BlockBlueVerified(ptr as BlueBlockerUser, config);
}

export function ParseTimelineTweet(tweet: any, config: Config) {
	if (IgnoreTweetTypes.has(tweet.itemContent.itemType)) {
		return;
	}

	let promoted: boolean = false;
	if (tweet?.itemContent?.promotedMetadata !== undefined) {
		promoted = true;
	} else if (PromotedStrings.has(tweet?.clientEventInfo?.component)) {
		promoted = true;
	} else if (PromotedStrings.has(tweet?.clientEventInfo?.details?.timelinesDetails?.injectionType)) {
		promoted = true;
	}

	try {
		// Handle retweets and quoted tweets (check the retweeted user, too)
		if (tweet?.itemContent?.tweet_results?.result?.quoted_status_result?.result) {
			handleTweetObject(
				tweet.itemContent.tweet_results.result.quoted_status_result.result,
				config,
				promoted,
			);
		} else if (tweet?.itemContent?.tweet_results?.result?.legacy?.retweeted_status_result?.result) {
			handleTweetObject(
				tweet.itemContent.tweet_results.result.legacy.retweeted_status_result.result,
				config,
				promoted,
			);
		}
		handleTweetObject(tweet.itemContent, config, promoted);
	} catch (e) {
		console.error(logstr, "found unexpected tweet shape:", tweet);
		api.storage.local.set({
			[EventKey]: {
				type: ErrorEvent,
			},
		});
	}
}

export function HandleInstructionsResponse(
	e: CustomEvent<BlueBlockerEvent>,
	body: Body,
	config: Config,
) {
	// pull the "instructions" object from the tweet
	let _instructions = body;
	for (const key of InstructionsPaths[e.detail.parsedUrl[1]]) {
		// @ts-ignore
		_instructions = _instructions[key];
	}

	// TODO: figure out how to do this cleanly
	// @ts-ignore
	const instructions: Instruction[] = _instructions;

	console.debug(logstr, 'parsed instructions path:', instructions);

	// "instructions" should be an array, we need to iterate over it to find the "TimelineAddEntries" type
	let tweets = undefined;
	let isAddToModule = false;
	for (const value of instructions) {
		if (value.type === 'TimelineAddEntries' || value.type === 'TimelineAddToModule') {
			tweets = value;
			isAddToModule = value.type === 'TimelineAddToModule';
			break;
		}
	}
	if (tweets === undefined) {
		console.error(logstr, 'response object does not contain an instruction to add entries', body);
		return;
	}

	tweets.entries = tweets.entries || [];
	if (isAddToModule) {
		// wrap AddToModule info so the handler can treat it the same (and unwrap it below)
		tweets.entries = [
			{
				content: {
					entryType: 'TimelineTimelineModule',
					items: tweets.moduleItems,
				},
			},
		];
	}

	// tweets object should now contain an array of all returned tweets
	for (const tweet of tweets.entries) {
		// parse each tweet for the user object
		switch (tweet?.content?.entryType) {
			case null:
				console.error(logstr, 'tweet structure does not match expectation', tweet);
				break;

			case 'TimelineTimelineItem':
				if (tweet.content.itemContent?.itemType == 'TimelineTweet') {
					ParseTimelineTweet(tweet.content, config);
				}
				break;

			case 'TimelineTimelineModule':
				for (const innerTweet of tweet.content.items || []) {
					ParseTimelineTweet(innerTweet.item, config);
				}
				break;

			default:
				if (!IgnoreTweetTypes.has(tweet.content.entryType)) {
					throw {
						message: `unexpected tweet type found: ${tweet?.content?.entryType}`,
						name: 'TweetType',
						tweet,
					};
				}
		}
	}

	if (isAddToModule) {
		tweets.moduleItems = tweets.entries?.[0]?.content?.items || [];
		delete tweets.entries;
	}
}
interface Body {
	data: {
		[key: string]: {
			home_timeline_urt?: Instruction[];
			result?: {
				timeline_v2: {
					timeline: { instructions: Instruction[] };
				};
			};
			instructions?: Instruction[];
		};
	};
}

// TODO: double check this interface
interface Instruction {
	type: string;
	direction?: string;
	moduleItems?: any;
	entries?: Entry[];
}

interface Entry {
	entryId?: string;
	sortIndex?: string;
	content: {
		itemContent?: {
			itemType: string;
		};
		entryType: string;
		items?: any[];
	};
}
