/**
 * The page the frame holds. The order of these imports is the whole point:
 * the mock has to be on the window before main.ts runs, and a static import
 * is evaluated in the order it is written.
 */
import "./touch";
import "../../src/lib/mock/install";
import "../../src/main";
