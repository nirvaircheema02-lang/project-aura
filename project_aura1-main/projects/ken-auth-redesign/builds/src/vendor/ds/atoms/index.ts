// Minimal local barrel — re-exports ONLY the atoms this standalone app actually
// uses, unlike the source design-system's real atoms/index.ts (which re-exports
// the entire atoms tier). Keeping this narrow avoids pulling unused components
// (and their own dependencies) into the standalone build.
export { Badge } from "./Badge";
export { BodyText } from "./BodyText";
export { Button } from "./Button";
export { Container } from "./Container";
export { Divider } from "./Divider";
export { InlineLink } from "./InlineLink";
export { SectionHeading } from "./SectionHeading";
