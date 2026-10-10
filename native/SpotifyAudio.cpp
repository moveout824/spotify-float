// Native process-tree WASAPI loopback. No system mix, files, microphone or video.
// API reference: Microsoft Windows-classic-samples/ApplicationLoopback (MIT).
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <sdkddkver.h>
#ifndef NTDDI_VERSION
#define NTDDI_VERSION NTDDI_WIN10_FE
#endif
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <audioclientactivationparams.h>
#include <wrl.h>
#include <propsys.h>
#include <tlhelp32.h>
#include <array>
#include <complex>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <set>

using Microsoft::WRL::ComPtr;
constexpr int N=2048, BINS=N/2;
constexpr double PI=3.14159265358979323846;
struct Activation final : Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,IActivateAudioInterfaceCompletionHandler,Microsoft::WRL::FtmBase> {
    HANDLE ready=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    HRESULT result=E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation(){if(ready)CloseHandle(ready);}
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated=E_UNEXPECTED;ComPtr<IUnknown> object;
        result=operation->GetActivateResult(&activated,&object);
        if(SUCCEEDED(result))result=activated;
        if(SUCCEEDED(result))result=object.As(&client);
        SetEvent(ready);return S_OK;
    }
};
void fft(std::array<std::complex<float>,N>& data){
    for(unsigned i=1,j=0;i<N;i++){unsigned bit=N>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)std::swap(data[i],data[j]);}
    for(int length=2;length<=N;length<<=1){const float angle=static_cast<float>(-2*PI/length);const std::complex<float> rotation(std::cos(angle),std::sin(angle));
        for(int i=0;i<N;i+=length){std::complex<float> w(1,0);for(int j=0;j<length/2;j++){auto a=data[i+j],b=data[i+j+length/2]*w;data[i+j]=a+b;data[i+j+length/2]=a-b;w*=rotation;}}
    }
}
#pragma pack(push,1)
struct Packet{uint32_t magic=0x46415455;uint32_t sequence=0;float rms=0,bass=0,treble=0,musicRms=0,musicPeak=0,bassRms=0,bassAmplitude=0;std::array<uint8_t,N> wave;std::array<uint8_t,BINS> frequency;};
#pragma pack(pop)
static_assert(sizeof(Packet)==3108);
int fail(const char* phase,HRESULT result){std::fprintf(stderr,"%s failed 0x%08lx\n",phase,static_cast<unsigned long>(result));return 2;}
DWORD spotifyRoot(){
    DWORD session=0;ProcessIdToSessionId(GetCurrentProcessId(),&session);
    HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snapshot==INVALID_HANDLE_VALUE)return 0;
    PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);std::vector<PROCESSENTRY32W> spotify;std::set<DWORD> ids;
    if(Process32FirstW(snapshot,&entry))do{DWORD processSession=0;if(_wcsicmp(entry.szExeFile,L"Spotify.exe")==0&&ProcessIdToSessionId(entry.th32ProcessID,&processSession)&&processSession==session){spotify.push_back(entry);ids.insert(entry.th32ProcessID);}}while(Process32NextW(snapshot,&entry));
    CloseHandle(snapshot);
    DWORD selected=0;ULONGLONG newest=0;
    for(const auto& process:spotify){if(ids.count(process.th32ParentProcessID))continue;HANDLE handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,process.th32ProcessID);if(!handle)continue;
        FILETIME created,ended,kernel,user;if(GetProcessTimes(handle,&created,&ended,&kernel,&user)){ULONGLONG time=(static_cast<ULONGLONG>(created.dwHighDateTime)<<32)|created.dwLowDateTime;if(time>newest){newest=time;selected=process.th32ProcessID;}}CloseHandle(handle);}
    return selected;
}
int wmain(int argc,wchar_t** argv){
    if(argc>2)return 1;
    const DWORD pid=argc==2?wcstoul(argv[1],nullptr,10):spotifyRoot();if(!pid){std::fprintf(stderr,"Spotify is not running\n");return 3;}
    HANDLE target=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!target)return fail("Open target",HRESULT_FROM_WIN32(GetLastError()));
    wchar_t filename[32768];DWORD chars=32768;
    if(!QueryFullProcessImageNameW(target,0,filename,&chars)){CloseHandle(target);return 2;}
    const wchar_t* leaf=wcsrchr(filename,L'\\');leaf=leaf?leaf+1:filename;
    if(_wcsicmp(leaf,L"Spotify.exe")!=0){std::fprintf(stderr,"Target is not Spotify.exe\n");CloseHandle(target);return 2;}
    HRESULT result=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(result)){CloseHandle(target);return fail("COM",result);}
    auto activation=Microsoft::WRL::Make<Activation>();
    AUDIOCLIENT_ACTIVATION_PARAMS parameters{};parameters.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    parameters.ProcessLoopbackParams.TargetProcessId=pid;parameters.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{};variant.vt=VT_BLOB;variant.blob.cbSize=sizeof(parameters);variant.blob.pBlobData=reinterpret_cast<BYTE*>(&parameters);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    result=ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),&variant,activation.Get(),&operation);
    if(FAILED(result))return fail("Activate",result);
    if(WaitForSingleObject(activation->ready,10000)!=WAIT_OBJECT_0)return fail("Activation timeout",E_FAIL);
    if(FAILED(activation->result))return fail("Activation result",activation->result);
    WAVEFORMATEX format{};format.wFormatTag=WAVE_FORMAT_PCM;format.nChannels=2;format.nSamplesPerSec=44100;format.wBitsPerSample=16;
    format.nBlockAlign=4;format.nAvgBytesPerSec=176400;
    result=activation->client->Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,&format,nullptr);
    if(FAILED(result))return fail("Initialize",result);
    HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)return 2;
    result=activation->client->SetEventHandle(event);if(FAILED(result))return fail("Audio event",result);
    ComPtr<IAudioCaptureClient> capture;result=activation->client->GetService(IID_PPV_ARGS(&capture));if(FAILED(result))return fail("Capture",result);
    result=activation->client->Start();if(FAILED(result))return fail("Start",result);
    std::fprintf(stderr,"Spotify process-loopback ready pid=%lu sample-rate=44100 include-tree\n",static_cast<unsigned long>(pid));
    std::array<float,N> ring{};std::array<std::complex<float>,N> spectrum{};std::array<float,N> hann{};
    for(int i=0;i<N;i++)hann[i]=static_cast<float>(0.5-0.5*std::cos(2*PI*i/(N-1)));
    int write=0;ULONGLONG lastPacket=GetTickCount64(),lastFrame=GetTickCount64();Packet packet;
    HANDLE waits[]={event,target};HANDLE output=GetStdHandle(STD_OUTPUT_HANDLE);bool running=true;
    while(running){
        DWORD wait=WaitForMultipleObjects(2,waits,FALSE,20);if(wait==WAIT_OBJECT_0+1||wait==WAIT_FAILED)break;
        UINT32 count=0;result=capture->GetNextPacketSize(&count);if(FAILED(result))break;
        while(count){
            BYTE* data=nullptr;UINT32 frames=0;DWORD flags=0;result=capture->GetBuffer(&data,&frames,&flags,nullptr,nullptr);if(FAILED(result)){running=false;break;}
            const auto* samples=reinterpret_cast<const int16_t*>(data);
            for(UINT32 i=0;i<frames;i++){const float sample=(flags&AUDCLNT_BUFFERFLAGS_SILENT)?0.0f:(static_cast<float>(samples[i*2])+samples[i*2+1])/65536.0f;ring[write]=sample;write=(write+1)%N;}
            capture->ReleaseBuffer(frames);lastPacket=GetTickCount64();capture->GetNextPacketSize(&count);
        }
        const ULONGLONG now=GetTickCount64();if(now-lastFrame<20)continue;lastFrame=now;
        double sum=0;const bool fresh=now-lastPacket<50;
        // Normalize before byte quantization. The reference is this live music
        // window's peak, not endpoint volume or a smoothed/outlier-filtered wave.
        float peak=0;for(int i=0;i<N;i++){const float sample=fresh?ring[(write+i)%N]:0.0f;peak=std::max(peak,std::abs(sample));}
        double recentPower=0;for(int i=0;i<512;i++){const float sample=fresh?ring[(write+N-1-i)%N]:0.0f;recentPower+=sample*sample;}
        const float recentRms=static_cast<float>(std::sqrt(recentPower/512));
        // A real silent tail must not keep drawing the old 46ms FFT window.
        const float gain=peak>=0.0001f&&recentRms>=0.00005f?0.88f/peak:0.0f;
        packet.musicRms=gain>0?recentRms:0.0f;packet.musicPeak=gain>0?peak:0.0f;
        for(int i=0;i<N;i++){float sample=(fresh?ring[(write+i)%N]:0.0f)*gain;sum+=sample*sample;packet.wave[i]=static_cast<uint8_t>(std::clamp(128+static_cast<int>(sample*127),0,255));spectrum[i]={sample*hann[i],0};}
        packet.rms=static_cast<float>(std::sqrt(sum/N));fft(spectrum);
        // Kick/body band before logarithmic byte quantization. Retain raw
        // envelope as well as the volume-normalized band for visual consumers.
        double bassPower=0;for(int i=1;i<=7;i++){const double amplitude=std::abs(spectrum[i])*2/N;const double weight=i==1?0.4:i==7?0.35:1.0;bassPower+=amplitude*amplitude*weight;}
        packet.bassAmplitude=static_cast<float>(std::clamp(std::sqrt(bassPower*4/3),0.0,1.0));packet.bassRms=gain>0?packet.bassAmplitude/gain:0.0f;
        for(int i=0;i<BINS;i++){float db=20*std::log10(std::max(std::abs(spectrum[i])*2/N,1e-9f));packet.frequency[i]=static_cast<uint8_t>(std::clamp((db+90)/70,0.0f,1.0f)*255);}
        packet.bass=0;for(int i=2;i<22;i++)packet.bass+=packet.frequency[i]/255.0f/20;
        packet.treble=0;for(int i=70;i<180;i++)packet.treble+=packet.frequency[i]/255.0f/110;
        packet.sequence++;DWORD written=0;if(!WriteFile(output,&packet,sizeof(packet),&written,nullptr)||written!=sizeof(packet))break;
    }
    activation->client->Stop();CloseHandle(event);CloseHandle(target);CoUninitialize();return 0;
}
