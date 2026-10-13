import test from "node:test";
import assert from "node:assert/strict";
import { supabaseHeaders } from "../src/supabase-headers.js";
test("modern secret key never becomes a bearer JWT; legacy integrations remain supported",()=>{
 assert.deepEqual(supabaseHeaders("sb_secret_fixture"),{apikey:"sb_secret_fixture"});
 assert.deepEqual(supabaseHeaders("legacy-fixture"),{apikey:"legacy-fixture",authorization:"Bearer legacy-fixture"});
});
