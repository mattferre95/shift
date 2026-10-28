import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { TrimPlayer } from "../src/features/input/TrimPlayer";
const { state } = vi.hoisted(() => ({state: {} as any}));
vi.mock("@/state/shift", () => ({useShift:()=>state}));
vi.mock("@tauri-apps/api/core", () => ({convertFileSrc:(path:string)=>path}));
let pause: ReturnType<typeof vi.fn>;
let play: ReturnType<typeof vi.fn>;
beforeEach(()=>{
 Object.assign(state,{duration:8,clipIn:"00:02.000",clipOut:"00:04.000",clipDurationPreset:15,clipEnabled:true,clipError:null,clipLabel:"00:02.000",clipSeconds:2,soundEnabled:true,showAspect:false,aspectPreview:null,setClipDurationPreset:vi.fn(),setClipIn:vi.fn(),setClipOut:vi.fn(),resizeClipIn:vi.fn(),resizeClipOut:vi.fn(),moveClipRange:vi.fn(),playback:{info:{path:"/tone.mp3",duration:8,hasVideo:false,hasAudio:true,proxy:false},busy:false,error:null,status:"ready",cancel:vi.fn(),retry:vi.fn(),fallback:vi.fn(),markReady:vi.fn()}});
 pause=vi.fn(function(this:HTMLMediaElement){Object.defineProperty(this,"paused",{value:true,configurable:true});this.dispatchEvent(new Event("pause"));});
 play=vi.fn(function(this:HTMLMediaElement){Object.defineProperty(this,"paused",{value:false,configurable:true});this.dispatchEvent(new Event("play"));return Promise.resolve();});
 vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(pause);
 vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(play);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function setup(){ const view=render(<TrimPlayer/>);const video=view.container.querySelector("video")!;fireEvent.loadedMetadata(video);fireEvent.canPlay(video);return {...view,video}; }
test("play starts at beginning, seek leaves bounds alone, Set IN/OUT use the playhead",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));await act(async()=>{});expect(video.currentTime).toBe(0);expect(play).toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("Seek playback"),{target:{value:3}});expect(video.currentTime).toBe(3);expect(state.setClipIn).not.toHaveBeenCalled();expect(state.setClipOut).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText("Set IN"));expect(state.setClipIn).toHaveBeenCalledWith("00:03.000");fireEvent.click(screen.getByText("Set OUT"));expect(state.setClipOut).toHaveBeenCalledWith("00:03.000");
});
test("drag handles use resize actions while typed edits use linked setters",()=>{
 setup();fireEvent.change(screen.getByLabelText("IN marker"),{target:{value:7}});expect(state.resizeClipIn).toHaveBeenCalledWith(7);
 fireEvent.change(screen.getByLabelText("OUT marker"),{target:{value:1}});expect(state.resizeClipOut).toHaveBeenCalledWith(1);
 fireEvent.change(screen.getByLabelText("IN",{selector:"input"}),{target:{value:"00:01.250"}});expect(state.setClipIn).toHaveBeenCalledWith("00:01.250");
});
test("handle timecodes follow the stored trim boundaries as both handles move",()=>{
 const {rerender}=setup();
 expect(screen.getByText("IN 00:02.000")).toBeTruthy();
 expect(screen.getByText("OUT 00:04.000")).toBeTruthy();
 state.resizeClipIn=vi.fn(()=>{state.clipIn="00:02.125";});
 fireEvent.change(screen.getByLabelText("IN marker"),{target:{value:2.125}});
 rerender(<TrimPlayer/>);
 expect(screen.getByText("IN 00:02.125")).toBeTruthy();
 expect(screen.getByText("OUT 00:04.000")).toBeTruthy();
 state.resizeClipOut=vi.fn(()=>{state.clipOut="00:07.999";});
 fireEvent.change(screen.getByLabelText("OUT marker"),{target:{value:8}});
 rerender(<TrimPlayer/>);
 expect(state.resizeClipOut).toHaveBeenCalledWith(8);
 expect(screen.getByText("OUT 00:07.999")).toBeTruthy();
 expect(screen.getByLabelText("OUT",{selector:"input"}).getAttribute("value")).toBe("00:07.999");
});
test("timecode labels stay inside the timeline and apart at edges and close handles",()=>{
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({x:0,y:0,left:0,top:0,right:320,bottom:48,width:320,height:48,toJSON:()=>({})});
 state.duration=3600.5;state.clipIn="00:00.000";state.clipOut="01:00:00.500";
 const {rerender}=setup();
 const position=(text:string)=>Number((screen.getByText(text) as HTMLElement).style.left.replace("px",""));
 expect(position("IN 00:00.000")).toBe(0);
 expect(position("OUT 01:00:00.500")).toBe(216);
 state.clipIn="00:00.001";state.clipOut="00:00.002";rerender(<TrimPlayer/>);
 expect(position("IN 00:00.001")).toBeGreaterThanOrEqual(0);
 expect(position("OUT 00:00.002")-position("IN 00:00.001")).toBeGreaterThanOrEqual(108);
 expect(position("OUT 00:00.002")+104).toBeLessThanOrEqual(320);
 state.clipIn="01:00:00.498";state.clipOut="01:00:00.500";rerender(<TrimPlayer/>);
 expect(position("IN 01:00:00.498")).toBeGreaterThanOrEqual(0);
 expect(position("OUT 01:00:00.500")-position("IN 01:00:00.498")).toBeGreaterThanOrEqual(108);
 expect(position("OUT 01:00:00.500")+104).toBeLessThanOrEqual(320);
});
test("Play Selection seeks to IN and stops at OUT",async()=>{
 const {video,rerender}=setup();state.clipIn="00:03.000";state.clipOut="00:05.000";rerender(<TrimPlayer/>);
 video.currentTime=6;fireEvent.click(screen.getByText("Play Selection"));await act(async()=>{});expect(video.currentTime).toBe(3);
 video.currentTime=5.02;fireEvent.timeUpdate(video);expect(pause).toHaveBeenCalled();expect(video.currentTime).toBe(5);
});
test("compact Dashboard exposes selection playback and defaults to Once",()=>{
 const view=render(<TrimPlayer compact/>);const video=view.container.querySelector("video")!;fireEvent.canPlay(video);
 expect(screen.getByRole("button",{name:"Play Selection"})).toBeTruthy();
 expect(screen.getByRole("group",{name:"Selection playback"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Once"}).getAttribute("aria-pressed")).toBe("true");
 expect(screen.getByRole("button",{name:"Loop"}).getAttribute("aria-pressed")).toBe("false");
});
test("Loop repeats the selected segment, including at media end",async()=>{
 const {video,rerender}=setup();fireEvent.click(screen.getByRole("button",{name:"Loop"}));
 fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 for(let cycle=0;cycle<3;cycle++){
  video.currentTime=4.01;fireEvent.timeUpdate(video);
  expect(video.currentTime).toBe(2);
  expect(pause).not.toHaveBeenCalled();
 }
 expect(play).toHaveBeenCalledTimes(1);
 // A selection ending at the media end may emit ended before the next frame.
 state.clipOut="00:08.000";rerender(<TrimPlayer/>);
 video.currentTime=8;Object.defineProperty(video,"paused",{value:true,configurable:true});fireEvent.ended(video);await act(async()=>{});
 expect(video.currentTime).toBe(2);expect(play).toHaveBeenCalledTimes(2);
});
test("Pause Selection holds the playhead and resumes inside the range",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Loop"}));
 fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 video.currentTime=3;fireEvent.timeUpdate(video);
 fireEvent.click(screen.getByRole("button",{name:"Pause Selection"}));
 expect(video.paused).toBe(true);expect(video.currentTime).toBe(3);
 fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 expect(video.currentTime).toBe(3);expect(play).toHaveBeenCalledTimes(2);
 video.currentTime=4;fireEvent.timeUpdate(video);expect(video.currentTime).toBe(2);
});
test("Once completes at OUT and the next selection play restarts at IN",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 video.currentTime=4.001;fireEvent.timeUpdate(video);
 expect(video.paused).toBe(true);expect(video.currentTime).toBe(4);
 fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 expect(video.currentTime).toBe(2);expect(play).toHaveBeenCalledTimes(2);
});
test("ordinary Play exits selection mode and continues beyond OUT",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 fireEvent.click(screen.getByRole("button",{name:"Pause Selection"}));
 fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));await act(async()=>{});
 video.currentTime=5;fireEvent.timeUpdate(video);
 expect(video.currentTime).toBe(5);expect(pause).toHaveBeenCalledTimes(1);
});
test("ordinary Play switches directly from active selection playback",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 expect(screen.getByRole("button",{name:"Play",exact:true})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));
 expect(video.paused).toBe(false);expect(screen.getByRole("button",{name:"Pause",exact:true})).toBeTruthy();
 video.currentTime=5;fireEvent.timeUpdate(video);expect(video.currentTime).toBe(5);
});
test("active selection follows changed custom bounds and stops when OUT moves behind playhead",async()=>{
 const {video,rerender}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 video.currentTime=3;fireEvent.timeUpdate(video);
 state.clipIn="00:03.500";rerender(<TrimPlayer/>);expect(video.currentTime).toBe(3.5);
 state.clipOut="00:03.750";rerender(<TrimPlayer/>);
 video.currentTime=3.8;fireEvent.timeUpdate(video);expect(video.currentTime).toBe(3.75);expect(video.paused).toBe(true);
});
test("preset changes use shared boundaries and Loop restarts at the new IN",async()=>{
 const {video,rerender}=setup();fireEvent.click(screen.getByRole("button",{name:"Loop"}));
 fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 state.clipIn="00:01.000";state.clipOut="00:06.000";state.clipDurationPreset=15;rerender(<TrimPlayer/>);
 video.currentTime=6.1;fireEvent.timeUpdate(video);expect(video.currentTime).toBe(1);
 expect(state.setClipDurationPreset).not.toHaveBeenCalled();
});
test("invalid or unknown range disables selection but leaves ordinary Play available",()=>{
 state.clipError="OUT has to come after IN.";const {rerender}=setup();
 expect((screen.getByRole("button",{name:"Play Selection"}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole("button",{name:"Play",exact:true}) as HTMLButtonElement).disabled).toBe(false);
 state.clipError=null;state.duration=null;rerender(<TrimPlayer/>);
 expect((screen.getByRole("button",{name:"Play Selection"}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole("button",{name:"Play Selection"}).getAttribute("title")).toMatch(/known duration/);
});
test("selection playback previews audio and video without altering export settings",async()=>{
 const {video,rerender}=setup();state.clipEnabled=false;rerender(<TrimPlayer/>);
 expect(screen.getByRole("button",{name:"Play Selection"}).getAttribute("title")).toMatch(/Export uses the full source/);
 fireEvent.click(screen.getByRole("button",{name:"Loop"}));fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 expect(video.getAttribute("aria-label")).toBe("Audio playback");expect(state.clipEnabled).toBe(false);
 expect(state.setClipIn).not.toHaveBeenCalled();expect(state.setClipOut).not.toHaveBeenCalled();
});
test("video selection uses the same player and honors OUT",async()=>{
 state.playback.info={...state.playback.info,path:"/film.mp4",hasVideo:true};
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 expect(video.getAttribute("aria-label")).toBe("Media preview");expect(video.currentTime).toBe(2);
 video.currentTime=4.1;fireEvent.timeUpdate(video);expect(video.currentTime).toBe(4);
});
test("source change and New Shift unmount stop old selection playback",async()=>{
 const {video,rerender,unmount}=setup();fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 state.playback.info={...state.playback.info,path:"/next.mp3"};rerender(<TrimPlayer/>);
 expect(pause).toHaveBeenCalled();expect(screen.getByRole("button",{name:"Play Selection"})).toBeTruthy();
 fireEvent.canPlay(video);fireEvent.click(screen.getByRole("button",{name:"Play Selection"}));await act(async()=>{});
 unmount();expect(pause).toHaveBeenCalledTimes(2);
});
test("duration chips select a target duration",()=>{
 setup();expect(screen.getByRole("button",{name:"15s"}).getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"30s"}));expect(state.setClipDurationPreset).toHaveBeenCalledWith(30);
 fireEvent.click(screen.getByRole("button",{name:"Custom"}));expect(state.setClipDurationPreset).toHaveBeenCalledWith("custom");
});
test("dragging the highlighted selection moves the whole range",()=>{
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({x:0,y:0,left:0,top:0,right:400,bottom:48,width:400,height:48,toJSON:()=>({})});
 setup();const selected=screen.getByRole("button",{name:"Move selection"});
 fireEvent.pointerDown(selected,{pointerId:1,clientX:100});fireEvent.pointerMove(selected,{pointerId:1,clientX:150});fireEvent.pointerUp(selected,{pointerId:1,clientX:150});
 expect(state.moveClipRange).toHaveBeenCalledWith(3);
});
test("invalid range cannot play selection; preview errors leave controls visible",()=>{
 state.clipError="OUT has to come after IN.";setup();expect((screen.getByRole("button",{name:"Play Selection"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText("OUT has to come after IN.")).toBeTruthy();
});
test("new source clears player position and failure requests proxy fallback",()=>{
 const {video,rerender}=setup();video.currentTime=3;fireEvent.timeUpdate(video);fireEvent.error(video);expect(state.playback.fallback).toHaveBeenCalled();
 state.playback.info={...state.playback.info,path:"/other.mp3"};rerender(<TrimPlayer/>);expect(screen.getByText(/00:00 \/ 00:08/)).toBeTruthy();
});
test("sound state mutes and unmutes the existing player immediately",()=>{
 const {video,rerender}=setup();expect(video.muted).toBe(false);
 state.soundEnabled=false;rerender(<TrimPlayer/>);expect(video.muted).toBe(true);
 state.soundEnabled=true;rerender(<TrimPlayer/>);expect(video.muted).toBe(false);
});
test("video waits for decoded frame pixels at time zero without autoplay",()=>{
 state.sourceMoves=true;state.previewImage="data:image/png;base64,first";
 state.playback.info={...state.playback.info,path:"/video.mp4",hasVideo:true};
 const view=render(<TrimPlayer compact/>);const video=view.container.querySelector("video")!;
 video.currentTime=2;fireEvent.loadedMetadata(video);
 expect(video.currentTime).toBe(0);
 expect(screen.getByText("Loading first frame…")).toBeTruthy();
 expect((screen.getByRole("button",{name:"Play"}) as HTMLButtonElement).disabled).toBe(true);
 expect(state.playback.markReady).not.toHaveBeenCalled();
 expect(video.getAttribute("poster")).toBe("data:image/png;base64,first");
 fireEvent.loadedData(video);
 expect(screen.queryByText("Loading first frame…")).toBeNull();
 expect(state.playback.markReady).toHaveBeenCalledTimes(1);
 expect(play).not.toHaveBeenCalled();
});
test("a failed video preview replaces the spinner with retry",()=>{
 state.playback.info={...state.playback.info,path:"/video.mp4",hasVideo:true};
 const view=render(<TrimPlayer compact/>);
 expect(screen.getByText("Loading first frame…")).toBeTruthy();
 state.playback.error="Preview failed";view.rerender(<TrimPlayer compact/>);
 expect(screen.queryByText("Loading first frame…")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Retry Preview"}));
 expect(state.playback.retry).toHaveBeenCalledTimes(1);
});
test("unknown duration keeps the timeline visible without a selectable range",()=>{
 state.duration=null;state.clipOut="00:15.000";setup();
 expect(screen.getByLabelText("Selected range")).toBeTruthy();
 expect(screen.getByText("Duration unknown · IN/OUT available when measured")).toBeTruthy();
 expect((screen.getByLabelText("IN marker") as HTMLInputElement).disabled).toBe(true);
 expect(screen.queryByLabelText("OUT",{selector:"input"})).toBeNull();
});
test("space pauses only outside editing controls",async()=>{
 const {video}=setup();fireEvent.keyDown(screen.getByLabelText("Trim player"),{code:"Space"});await act(async()=>{});expect(play).toHaveBeenCalledTimes(1);
 fireEvent.keyDown(screen.getByLabelText("IN",{selector:"input"}),{code:"Space"});expect(pause).not.toHaveBeenCalled();fireEvent.keyDown(screen.getByLabelText("Trim player"),{code:"Space"});expect(pause).toHaveBeenCalled();expect(video.paused).toBe(true);
});
