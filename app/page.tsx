
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/consultation");
  return null;
}
