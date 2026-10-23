#pragma once
#include <cmath>

class LevelEnvelope {
    const float mix;
    float energy=0;
public:
    explicit LevelEnvelope(double sampleRate=44100)
        : mix(static_cast<float>(1-std::exp(-1/(sampleRate*.010)))) {}
    void process(float sample) { energy+=mix*(sample*sample-energy); }
    float rms() const { return std::sqrt(std::fmax(0.0f,energy)); }
};

// Causal bass envelope: reject DC/voice harmonics and average carrier cycles
// without the centered FFT window's latency. No clock-generated beat signal.
class BassEnvelope {
    const float highDecay, lowMix, energyMix;
    float previous=0, high=0, low=0, low2=0, energy=0;
public:
    explicit BassEnvelope(double sampleRate=44100)
        : highDecay(static_cast<float>(std::exp(-2*3.141592653589793*35/sampleRate))),
          lowMix(static_cast<float>(1-std::exp(-2*3.141592653589793*180/sampleRate))),
          energyMix(static_cast<float>(1-std::exp(-1/(sampleRate*.012)))) {}
    void process(float sample) {
        high=highDecay*(high+sample-previous);previous=sample;
        low+=lowMix*(high-low);low2+=lowMix*(low-low2);
        energy+=energyMix*(low2*low2-energy);
    }
    float rms() const { return std::sqrt(std::fmax(0.0f,energy)); }
};
