import { PreviewBar, PreviewNotes } from './runtime/PreviewChrome';
import { ScrollEffects } from './runtime/ScrollEffectsHost';
import SectionWhatYourCustomersThinkIsnTAMysteryItSAmetric from './generated/sections/SectionWhatYourCustomersThinkIsnTAMysteryItSAmetric';
import SectionSeeYourBrandInData from './generated/sections/SectionSeeYourBrandInData';
import SectionUseRealFeedbackFromRealAudiencesToUnderstandWhatDrivesDecisionsAndActWithConfidence from './generated/sections/SectionUseRealFeedbackFromRealAudiencesToUnderstandWhatDrivesDecisionsAndActWithConfidence';
import SectionWhyItMatters from './generated/sections/SectionWhyItMatters';
import SectionCompetitorAdvantagesOverlooked from './generated/sections/SectionCompetitorAdvantagesOverlooked';
import SectionHowWeDoIt from './generated/sections/SectionHowWeDoIt';
import SectionWhatSetsUsApart from './generated/sections/SectionWhatSetsUsApart';
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
        <SectionWhatYourCustomersThinkIsnTAMysteryItSAmetric />
        <SectionSeeYourBrandInData />
        <SectionUseRealFeedbackFromRealAudiencesToUnderstandWhatDrivesDecisionsAndActWithConfidence />
        <SectionWhyItMatters />
        <SectionCompetitorAdvantagesOverlooked />
        <SectionHowWeDoIt />
        <SectionWhatSetsUsApart />
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
