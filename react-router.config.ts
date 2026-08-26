import type { Config } from "@react-router/dev/config";

export default {
	// Server-rendered: the index loader supplies last-generated / cooldown / file
	// list so the first paint is already correct, with no client fetch or spinner.
	ssr: true,
	appDirectory: "app",
} satisfies Config;
