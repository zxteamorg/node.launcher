/*
// This is a test application for manual testing
// Run:
//   node --require=ts-node/register test/LaucherCancellationToken.ts; echo $?
// Test plan:
// - Start the app
// - Send SIGTERM or SIGINT signal
// - The application should complete with warning message: "Runtime initialization was cancelled by user" + exit code = 0
*/


import { sleep } from "@zxteam/cancellation";

import { launcher } from "../src/index";

launcher(
	//async () => { return null/* no configuration */; },
	async (cancellationToken, notUsedConfiguration) => {

		console.log("Enter into long sleep...");
		await sleep(cancellationToken, 6000);

		return {
			async destroy() { return Promise.resolve(); }
		};
	}
);
