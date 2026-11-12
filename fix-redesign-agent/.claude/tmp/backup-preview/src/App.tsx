import { PreviewBar, PreviewNotes } from './runtime/PreviewChrome';
import { ScrollEffects } from './runtime/ScrollEffectsHost';
import SectionYourDealersKnowWhatYourDataDoesnT from './generated/sections/SectionYourDealersKnowWhatYourDataDoesnT';
import SectionDealerInsightsDashboard from './generated/sections/SectionDealerInsightsDashboard';
import SectionOurClients from './generated/sections/SectionOurClients';
import SectionWhatSImpactingYourDealers from './generated/sections/SectionWhatSImpactingYourDealers';
import SectionHowWeCaptureDealerNeeds from './generated/sections/SectionHowWeCaptureDealerNeeds';
import SectionWhatMakesOurWayDifferent from './generated/sections/SectionWhatMakesOurWayDifferent';
import SectionOurImpact from './generated/sections/SectionOurImpact';
import SectionWhatOurClientsSay from './generated/sections/SectionWhatOurClientsSay';
import SectionFaqs from './generated/sections/SectionFaqs';
import SectionOurResources from './generated/sections/SectionOurResources';
import SectionExploreOtherSurveys from './generated/sections/SectionExploreOtherSurveys';

export default function App() {
  return (
    <>
      <PreviewBar />
      <ScrollEffects />
      <main>
        <SectionYourDealersKnowWhatYourDataDoesnT />
        <SectionDealerInsightsDashboard />
        <SectionOurClients />
        <SectionWhatSImpactingYourDealers />
        <SectionHowWeCaptureDealerNeeds />
        <SectionWhatMakesOurWayDifferent />
        <SectionOurImpact />
        <SectionWhatOurClientsSay />
        <SectionFaqs />
        <SectionOurResources />
        <SectionExploreOtherSurveys />
      </main>
      <PreviewNotes />
    </>
  );
}
