/*
// This is a test application for manual testing
// Run:
//   node --require=ts-node/register test/LaucherFailedRuntimeInitialization.ts; echo $?
// Test plan:
// - Start the app
// - The application should complete with fatal message: " Runtime initialization failed with error: xxxxxx" + exit code = 127
*/

import { launcher } from "../src/index";

launcher(
	//async () => { return null/* no configuration */; },
	async (cancellationToken, notUsedConfiguration) => {

		throw new Error("Someting wrong");
	}
);
