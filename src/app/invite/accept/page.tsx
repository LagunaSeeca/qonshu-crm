import { Suspense } from "react";
import { AcceptForm } from "./AcceptForm";

export default function AcceptPage() {
  return (
    <Suspense fallback={<div className="max-w-sm mx-auto mt-24">Loading...</div>}>
      <AcceptForm />
    </Suspense>
  );
}
