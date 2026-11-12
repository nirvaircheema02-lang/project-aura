import Icon from "./Icon.jsx";
import { WA_URL } from "../data/constants.js";

export default function WhatsAppFloat() {
  return (
    <a href={WA_URL} target="_blank" rel="noreferrer" className="wa-float" aria-label="Chat on WhatsApp">
      <Icon name="msg" size={22} />
    </a>
  );
}
