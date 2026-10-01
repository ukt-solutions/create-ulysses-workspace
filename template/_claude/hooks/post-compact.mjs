#!/usr/bin/env node
// PostCompact hook — remind user that earlier context was lost
import { respond } from './_utils.mjs';

respond(`Earlier context was compacted. Discussion details from before this point may be incomplete.

If you had uncaptured decisions or progress, use /braindump or /handoff now while you still remember.`);
