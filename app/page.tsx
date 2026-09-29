import { redirect } from "next/navigation";

// "/" is rewritten to the Tag Bot screen in next.config.mjs; this is only a fallback.
export default function Page() {
  redirect("/tagbot.html");
}
