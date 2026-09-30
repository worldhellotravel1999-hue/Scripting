import { VStack } from "scripting"
import { AppRavenCollectionsPage } from "./views/appraven-collections"

export default function PreviewCollections() {
  return (
    <VStack spacing={0} frame={{ width: 371, height: 420 }} background="clear">
      <AppRavenCollectionsPage appid="1490607195" appTitle="AppRaven" />
    </VStack>
  )
}
