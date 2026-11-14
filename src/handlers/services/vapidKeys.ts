export interface VapidConfig {
	publicKey: string;
	privateKey: string;
	subject: string;
}

export const VAPID: VapidConfig = {
	publicKey: "BCAaUswzf6dz9VMT4dH9bjQrvRAS-ohNpuZYeFuSlbDa6bX6uo6tUEPyIyy9OLCz7210vcLbqEvCg56VXP3vA9A",
	privateKey: "sGWbxYf9hrqzmrz0Z6-b1gT-82cVuI-GVtbPTnYtYjE",
	subject: "https://airsend.in",
};
