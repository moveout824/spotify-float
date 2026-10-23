#include "../native/AudioEnvelope.h"
#include <algorithm>
#include <cstdio>
#include <vector>

int main() {
    constexpr double pi=3.141592653589793,rate=44100;
    float maximumRipple=0,maximumLevelRipple=0;double slowestHalfRise=0;
    for(double frequency:{35.,50.,80.,120.,180.}) {
        BassEnvelope envelope;LevelEnvelope level;float minimum=10,maximum=0,levelMin=10,levelMax=0;
        std::vector<float> onset;
        for(int i=0;i<static_cast<int>(rate);i++) {
            const float sample=static_cast<float>(.4*std::sin(2*pi*frequency*i/rate));envelope.process(sample);level.process(sample);
            if(i<static_cast<int>(rate*.08))onset.push_back(envelope.rms());
            if(i>rate*.5){minimum=std::min(minimum,envelope.rms());maximum=std::max(maximum,envelope.rms());levelMin=std::min(levelMin,level.rms());levelMax=std::max(levelMax,level.rms());}
        }
        const float reference=(minimum+maximum)*.5f,ripple=(maximum-minimum)/reference;
        maximumRipple=std::max(maximumRipple,ripple);
        auto half=std::find_if(onset.begin(),onset.end(),[reference](float x){return x>=reference*.5f;});
        double halfRise=std::distance(onset.begin(),half)/rate*1000;slowestHalfRise=std::max(slowestHalfRise,halfRise);
        if(ripple>.20f||halfRise>25)return 1;
        maximumLevelRipple=std::max(maximumLevelRipple,(levelMax-levelMin)/((levelMax+levelMin)*.5f));
        if(maximumLevelRipple>.25f)return 3;
        BassEnvelope quiet;
        for(int i=0;i<44100;i++)quiet.process(static_cast<float>(4e-6*std::sin(2*pi*frequency*i/rate)));
        if(quiet.rms()<=1e-8f)return 2;
    }
    std::printf("{\"continuousBassToneMaxRipple\":%.4f,\"continuousFullBandToneMaxRipple\":%.4f,\"slowestBassHalfRiseMs\":%.3f,\"quietBassPreserved\":true,\"passed\":true}\n",maximumRipple,maximumLevelRipple,slowestHalfRise);
}
